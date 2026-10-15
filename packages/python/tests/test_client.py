import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from pydantic import BaseModel
from herald import ActionAnswer, Herald, HeraldError, LiveSocket, Message, Tombstone, backoff
from websockets.exceptions import InvalidStatus


class Approval(BaseModel):
    approved: bool
    notes: str | None = None


def message(status="pending", **extra):
    return Message(id="one", title="Request", status=status, **extra)


def mock(handle):
    return Herald(api_key="test-only", url="https://herald.test", transport=httpx.MockTransport(handle))


class FakeSocket:
    """A live connection that delivers `events` and then stays open until closed."""

    def __init__(self, opened, events=()):
        self.opened, self.events, self.closed = opened, list(events), asyncio.Event()

    async def __aenter__(self):
        self.opened.append(self)
        return self

    async def __aexit__(self, *_):
        pass

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.events:
            return self.events.pop(0)
        await self.closed.wait()
        raise StopAsyncIteration


class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_websocket_redirect_cannot_forward_the_token(self):
        received = []
        async def collect(reader, writer):
            received.append(await reader.readuntil(b"\r\n\r\n"))
            writer.close()
            await writer.wait_closed()
        sink = await asyncio.start_server(collect, "127.0.0.1", 0)
        port = sink.sockets[0].getsockname()[1]
        async def redirect(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(f"HTTP/1.1 307 Temporary Redirect\r\nLocation: ws://127.0.0.1:{port}/collect\r\nContent-Length: 0\r\n\r\n".encode())
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        source = await asyncio.start_server(redirect, "127.0.0.1", 0)
        try:
            async with Herald(api_key="test-only-token", url=f"http://127.0.0.1:{source.sockets[0].getsockname()[1]}") as client:
                with self.assertRaises(InvalidStatus):
                    await client.socket()
            self.assertEqual(received, [])
        finally:
            source.close()
            sink.close()
            await source.wait_closed()
            await sink.wait_closed()

    async def test_redirects_are_not_success_or_followed(self):
        requests = []
        def handle(request):
            requests.append(request)
            if request.url.path == "/api/v1/files" and request.method == "POST":
                return httpx.Response(201, json={"id": "reserved", "name": "private", "size": 7, "type": "text/plain"})
            return httpx.Response(307, headers={"Location": "https://other.example/collect"}, json={"id": "not-success"})
        async with mock(handle) as client:
            with self.assertRaises(HeraldError) as caught:
                await client.send(title="Private", idempotency_key="stable")
            self.assertEqual(caught.exception.status, 307)
            with self.assertRaises(HeraldError):
                await client.upload("private", b"private")
        self.assertEqual(len(requests), 3)
        self.assertTrue(all(request.url.host == "herald.test" for request in requests))

    async def test_thread_history_follows_pages(self):
        async with Herald() as client:
            client.request = AsyncMock(side_effect=[
                {"messages": [{"id": "root", "title": "Root", "status": "answered"}], "next": 1},
                {"messages": [{"id": "reply", "title": "Reply", "status": "pending", "replyTo": "root"}]},
            ])
            messages = [m async for m in client.thread_messages("reply")]
            self.assertEqual([m.id for m in messages], ["root", "reply"])
            self.assertEqual(messages[1].reply_to, "root")
            self.assertEqual(client.request.await_args_list[1].args[0], "/messages/reply/thread?after=1")

    async def test_feed_parses_tombstones_and_future_values(self):
        page = [{"id": "gone", "revision": 4, "deleted": True}, {"id": "new", "title": "New", "status": "archived", "revision": 5, "execution": {"logs": [{"sequence": 0, "stream": "trace", "text": "hi"}]}}]
        async with Herald() as client:
            client.request = AsyncMock(return_value=page)
            gone, new = await client.messages(after=3, tombstones=1)
            client.request.assert_awaited_once_with("/messages?after=3&tombstones=1")
        self.assertIsInstance(gone, Tombstone)
        self.assertEqual((new.status, new.execution.logs[0].stream), ("archived", "trace"))
        self.assertEqual([gone.wire(), new.wire()], page)

    async def test_retry_preserves_creation_key_and_payload(self):
        requests = []
        def handle(request):
            requests.append(request)
            if len(requests) == 1:
                raise httpx.ConnectError("Connection lost", request=request)
            return httpx.Response(201, json={"id": "one", "title": "Hello", "status": "pending"})
        with patch("herald.client.asyncio.sleep", new_callable=AsyncMock):
            async with mock(handle) as client:
                self.assertEqual((await client.send(title="Hello", idempotency_key="stable")).id, "one")
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].content, requests[1].content)
        self.assertEqual(requests[1].headers["Idempotency-Key"], "stable")

    async def test_waits_out_retry_after_even_for_unkeyed_writes(self):
        replies = [httpx.Response(429, headers={"Retry-After": "2"}, json={"error": "Slow down."}), httpx.Response(200, json={"id": "t", "title": "Run", "status": "failed"})]
        sleep = AsyncMock()
        with patch("herald.client.asyncio.sleep", sleep):
            async with mock(lambda _: replies.pop(0)) as client:
                self.assertEqual((await client.update_task("t", lease="l", status="failed")).status, "failed")
        sleep.assert_awaited_once_with(2)
        replies[:] = [httpx.Response(429, headers={"Retry-After": "120"}, json={"error": "Slow down."})]
        async with mock(lambda _: replies.pop(0)) as client:
            with self.assertRaises(HeraldError) as caught:
                await client.update_task("t", lease="l", status="failed")
        self.assertEqual((caught.exception.status, caught.exception.retry_after), (429, 120))

    async def test_unkeyed_writes_never_retry_server_errors(self):
        calls = []
        def handle(request):
            calls.append(request)
            return httpx.Response(502, text="<html>Bad gateway</html>", headers={"Content-Type": "text/html"})
        async with mock(handle) as client:
            with self.assertRaises(HeraldError) as caught:
                await client.cancel("m")
        self.assertEqual((str(caught.exception), caught.exception.status, len(calls)), ("Herald request failed (502).", 502, 1))

    async def test_checks_content_type_before_parsing(self):
        replies = [httpx.Response(200, text="<html>Portal</html>", headers={"Content-Type": "text/html"}), httpx.Response(204)]
        async with mock(lambda _: replies.pop(0)) as client:
            with self.assertRaises(HeraldError):
                await client.request("/messages")
            self.assertIsNone(await client.request("/messages/m", method="DELETE"))

    async def test_upload_streams_with_an_idle_timeout_and_attaches(self):
        bodies, sent = [], []
        async def handle(request):
            if request.url.path.endswith("/messages"):
                sent.append(json.loads(await request.aread()))
                return httpx.Response(201, json={"id": "m", "title": "Log", "status": "delivered"})
            if request.method == "POST":
                return httpx.Response(201, json={"id": "f", "name": "log", "size": 6, "type": "text/plain", "owner": "internal"})
            bodies.append((request.headers["Content-Length"], await request.aread()))
            return httpx.Response(200, json={"ok": True})
        async def source():
            yield b"abc"
            yield b"def"
        async with mock(handle) as client:
            file = await client.upload("log", source(), "text/plain", size=6)
            self.assertEqual(file.wire(), {"id": "f", "name": "log", "size": 6, "type": "text/plain"})
            self.assertEqual(bodies, [("6", b"abcdef")])
            await client.send(title="Log", kind="files", attachments=[file])
            self.assertEqual(sent[0]["attachments"], [file.wire()])
            async def stalled():
                yield b"abc"
                await asyncio.sleep(1)
                yield b"def"
            with self.assertRaises(HeraldError) as caught:
                await client.upload("log", stalled(), "text/plain", size=6, idle_timeout=0.05)
            self.assertEqual(caught.exception.status, 408)
            with self.assertRaises(ValueError):
                await client.upload("log", stalled(), "text/plain")

    async def test_pydantic_schema_and_typed_response(self):
        async with Herald() as client:
            client.send = AsyncMock(return_value=message())
            client.wait = AsyncMock(return_value=message("answered", response={"values": {"approved": True}}))
            answer = await client.ask(title="Deploy?", schema=Approval, timeout=600, wait_timeout=2)
            self.assertIsInstance(answer, Approval)
            self.assertTrue(answer.approved)
            sent = client.send.call_args.kwargs
            self.assertEqual(sent["schema"]["properties"]["approved"]["type"], "boolean")
            self.assertEqual(sent["expiresIn"], 600)
            client.wait.assert_awaited_once_with("one", wait_timeout=2)

    async def test_wait_timeout_does_not_cancel(self):
        async with Herald() as client:
            client.send = AsyncMock(return_value=message())
            client.wait = AsyncMock(side_effect=HeraldError("Timeout", 408, "one"))
            client.cancel = AsyncMock()
            with self.assertRaises(HeraldError) as caught:
                await client.ask(title="Wait")
            self.assertEqual(caught.exception.message_id, "one")
            client.cancel.assert_not_awaited()

    async def test_wait_recovers_http_state_when_websocket_is_unavailable(self):
        async with Herald() as client:
            client.get = AsyncMock(side_effect=[HeraldError("Busy", 503), message(), message("answered")])
            client.live = LiveSocket(lambda: (_ for _ in ()).throw(OSError("Disconnected")), delay=lambda _: 0.01)
            with patch("herald.client.POLL", 0.01):
                self.assertEqual((await client.wait("one", wait_timeout=1)).status, "answered")
            self.assertEqual(client.live._events, set())

    async def test_wait_does_not_retry_authorization_failures(self):
        async with Herald() as client:
            client.get = AsyncMock(side_effect=HeraldError("Forbidden", 403))
            with self.assertRaises(HeraldError):
                await client.wait("one", wait_timeout=1)
            self.assertEqual(client.get.await_count, 1)

    async def test_waiters_share_one_socket_and_wake_on_events(self):
        opened = []
        async with Herald() as client:
            client.live = LiveSocket(lambda: FakeSocket(opened, ["sync"]))
            states = {"a": ["pending", "answered"], "b": ["pending", "answered"]}
            client.get = AsyncMock(side_effect=lambda id: Message(id=id, title="Request", status=states[id].pop(0) if len(states[id]) > 1 else states[id][0]))
            results = await asyncio.gather(client.wait("a", wait_timeout=5), client.wait("b", wait_timeout=5))
            self.assertEqual([r.status for r in results], ["answered", "answered"])
            self.assertEqual(len(opened), 1)
            await asyncio.sleep(0)
            self.assertIsNone(client.live._task)

    async def test_socket_reconnects_with_jittered_backoff(self):
        self.assertEqual([backoff(n, lambda: 1) for n in (0, 1, 5, 9)], [1, 2, 30, 30])
        self.assertEqual(backoff(3, lambda: 0), 4)
        delays, opened = [], []
        def connect():
            if len(opened) < 3:
                opened.append(None)
                raise OSError("Disconnected")
            return FakeSocket(opened)
        live = LiveSocket(connect, delay=lambda attempt: delays.append(attempt) or 0)
        event = live.subscribe()
        await asyncio.wait_for(event.wait(), 1)
        live.unsubscribe(event)
        self.assertEqual(delays, [0, 1, 2])

    async def test_action_response_preserves_selected_id_and_empty_values(self):
        actions = [{"id": "resume", "label": "Resume run", "values": {}}]
        async with Herald() as client:
            client.send = AsyncMock(return_value=message())
            client.wait = AsyncMock(return_value=message("answered", response={"actionId": "resume", "values": {}}))
            self.assertEqual(await client.ask_action(title="Continue?", actions=actions, timeout=300, wait_timeout=2, idempotency_key="stable"), ActionAnswer(action_id="resume", values={}))
            sent = client.send.call_args.kwargs
            self.assertEqual(sent["actions"], actions)
            self.assertEqual(sent["expiresIn"], 300)
            self.assertEqual(sent["idempotency_key"], "stable")
            client.wait.assert_awaited_once_with("one", wait_timeout=2)
            self.assertEqual(await client.ask(title="Continue?", actions=actions), {})

    async def test_action_response_rejects_missing_or_unknown_action(self):
        actions = [{"id": "resume", "label": "Resume run", "values": {}}]
        async with Herald() as client:
            client.send = AsyncMock(return_value=message())
            client.wait = AsyncMock()
            with self.assertRaises(ValueError):
                await client.ask_action(title="Continue?", actions=[])
            client.send.assert_not_awaited()
            for action_id in (None, "unknown"):
                client.wait.return_value = message("answered", response={"actionId": action_id, "values": {}})
                with self.assertRaises(HeraldError) as caught:
                    await client.ask_action(title="Continue?", actions=actions)
                self.assertEqual(caught.exception.status, 502)
                self.assertEqual(caught.exception.message_id, "one")

    async def test_action_response_returns_pydantic_values_and_expiry(self):
        actions = [{"id": "approve", "label": "Approve", "values": {"approved": True}}]
        async with Herald() as client:
            client.send = AsyncMock(return_value=message())
            client.wait = AsyncMock(return_value=message("answered", response={"actionId": "approve", "values": {"approved": True}}))
            answer = await client.ask_action(title="Deploy?", actions=actions, schema=Approval)
            self.assertEqual((answer.action_id, answer.values), ("approve", Approval(approved=True)))
            self.assertEqual(json.loads(answer.model_dump_json(by_alias=True)), {"actionId": "approve", "values": {"approved": True, "notes": None}})
            self.assertEqual(client.send.call_args.kwargs["schema"]["properties"]["approved"]["type"], "boolean")
            client.wait.return_value = message("expired")
            with self.assertRaises(HeraldError) as caught:
                await client.ask_action(title="Deploy?", actions=actions)
            self.assertEqual(caught.exception.status, 410)
            self.assertEqual(caught.exception.message_id, "one")
