"""The Python side of the shared contract fixtures (packages/sdk/fixtures/contracts.ts)."""
import json
import re
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote

import httpx
from pydantic import BaseModel
from herald import Envelope, Herald, HeraldError, TaskLog

FIXTURES = json.loads((Path(__file__).parents[2] / "sdk/fixtures/contracts.json").read_text())
SAMPLES = {"<id>": lambda step: step + "-id", "<time>": lambda _: "2030-01-01T00:00:00.000Z", "<string>": lambda _: "string", "<number>": lambda _: 1}


def lookup(results, ref):
    value = results
    for key in ref.split("."):
        value = value.get(key) if isinstance(value, dict) else None
    return value


def substitute(value, results):
    if isinstance(value, str):
        whole = re.fullmatch(r"\{([\w.-]+)\}", value)
        if whole:
            return lookup(results, whole[1])
        return re.sub(r"\{([\w.-]+)\}", lambda m: str(lookup(results, m[1])), value)
    if isinstance(value, list):
        return [substitute(v, results) for v in value]
    if isinstance(value, dict):
        return {k: substitute(v, results) for k, v in value.items()}
    return value


def materialize(value, step):
    if isinstance(value, str) and value in SAMPLES:
        return SAMPLES[value](step)
    if isinstance(value, list):
        return [materialize(v, step) for v in value]
    if isinstance(value, dict):
        return {k: materialize(v, step) for k, v in value.items()}
    return value


def plain(value):
    """SDK results as JSON; methods for `{ok: true}` replies return None."""
    if value is None:
        return {"ok": True}
    if isinstance(value, BaseModel):
        return value.wire()
    if isinstance(value, list):
        return [plain(v) for v in value]
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    return value


async def text_of(download):
    return (await download).data.decode()


async def logs_of(logs):
    return {"logs": await logs}


def send(h, a):
    return h.send(idempotency_key=a.key, **a.body)


CALLS = {
    "register": lambda h, a: h.register(**a.body),
    "destinations": lambda h, a: h.destinations(),
    "update-destination": lambda h, a: h.update_destination(a.id, **a.body),
    "upload": lambda h, a: h.upload("notes.txt", b"hello", "text/plain"),
    "send": send,
    "get": lambda h, a: h.get(a.id),
    "thread": lambda h, a: h.thread(a.id),
    "messages": lambda h, a: h.messages(after=0),
    "get-missing": lambda h, a: h.get(a.id),
    "send-secret-form": send,
    "collect-secrets": lambda h, a: h.collect_secrets(a.id),
    "download": lambda h, a: text_of(h.download(a.id)),
    "read-task-logs": lambda h, a: logs_of(h.task_logs(a.id)),
    "rotate-secret": lambda h, a: h.rotate_destination_secret(a.id),
    "account": lambda h, a: h.account(),
    "offer-secret": send,
    "secret-receiver": lambda h, a: h.secret_receiver(a.id),
    "deliver-secret": lambda h, a: h.deliver_secret(a.id, claim_id=a.body["claimId"], envelope=Envelope(**a.body["envelope"])),
    "cancel": lambda h, a: h.cancel(a.id),
    "claim-task": lambda h, a: h.claim_task(a.id, runner_id=a.body["runnerId"], heartbeat=a.body["heartbeat"]),
    "heartbeat-task": lambda h, a: h.heartbeat_task(a.id, a.body["lease"]),
    "task-logs": lambda h, a: h.update_task(a.id, lease=a.body["lease"], logs=[TaskLog(**log) for log in a.body["logs"]], idempotency_key=a.key),
    "complete-task": lambda h, a: h.update_task(a.id, lease=a.body["lease"], status=a.body["status"]),
    "delete-destination": lambda h, a: h.delete_destination(a.id),
    "create-integration": lambda h, a: h.create_integration(name=a.body["name"], scopes=a.body["scopes"]),
    "integrations": lambda h, a: h.integrations(),
    "delete-integration": lambda h, a: h.delete_integration(a.id),
}


class ContractTests(unittest.IsolatedAsyncioTestCase):
    def test_every_sdk_step_is_mapped(self):
        self.assertEqual(sorted(CALLS), sorted(s["name"] for s in FIXTURES["steps"] if not s.get("setup")))

    async def test_fixture_requests_and_responses(self):
        replies, seen = [], []

        async def handle(request):
            text = (await request.aread()).decode()
            seen.append({"method": request.method, "path": unquote(request.url.raw_path.decode()), "headers": request.headers, "body": json.loads(text) if request.headers.get("Content-Type") == "application/json" else text})
            self.assertEqual(request.headers["Authorization"], "Bearer test-only")
            reply = replies.pop(0)
            # A string body is a file download's bytes.
            if isinstance(reply["body"], str):
                return httpx.Response(reply["status"], content=reply["body"].encode())
            return httpx.Response(reply["status"], json=reply["body"])

        results = {"values": FIXTURES["values"]}

        def concrete(name, reply):
            return {"status": reply["status"], "body": substitute(materialize(reply["body"], name), results)}

        async with Herald(api_key="test-only", url="https://herald.test", transport=httpx.MockTransport(handle)) as client:
            for step in FIXTURES["steps"]:
                name = step["name"]
                response = concrete(name, step["response"])
                if step.get("setup"):
                    results[name] = response["body"]
                    continue
                request = substitute(step["request"], results)
                replies[:] = [response] + ([concrete(name, step["upload"]["response"])] if "upload" in step else [])
                parts = request["path"].split("?")[0].split("/")
                args = SimpleNamespace(body=request.get("body"), key=request.get("headers", {}).get("Idempotency-Key"), id=unquote(parts[4]) if len(parts) > 4 else "")
                with self.subTest(name):
                    if response["status"] >= 400:
                        with self.assertRaises(HeraldError) as caught:
                            await CALLS[name](client, args)
                        self.assertEqual((caught.exception.status, str(caught.exception)), (response["status"], response["body"]["error"]))
                    else:
                        self.assertEqual(plain(await CALLS[name](client, args)), response["body"])
                    sent = seen.pop(0)
                    self.assertEqual((sent["method"], sent["path"], sent["body"]), (request["method"], request["path"], request.get("body", "")))
                    for header, value in request.get("headers", {}).items():
                        self.assertEqual(sent["headers"].get(header), value)
                    if "upload" in step:
                        upload = seen.pop(0)
                        path = substitute(step["upload"]["path"], {**results, name: response["body"]})
                        self.assertEqual((upload["method"], upload["path"], upload["body"]), ("PUT", path, step["upload"]["text"]))
                    self.assertEqual(seen, [])
                results[name] = response["body"]
