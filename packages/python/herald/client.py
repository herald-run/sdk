import asyncio
import os
import re
import uuid
from urllib.parse import quote, unquote, urlencode, urlparse

import httpx
from pydantic import BaseModel
from websockets.asyncio.client import connect

from ._version import __version__
from . import e2ee
from .crypto import unseal
from .http import HeraldError, chunks, idle_body, parse_retry_after, raise_error, read_json, retry_delay, retryable
from .keyed import KeyedSession
from .live import LiveSocket
from .models import Account, ActionAnswer, Attachment, CreatedIntegration, Destination, Envelope, FileDownload, Integration, Lease, Message, Ping, SecretReceiver, TaskClaim, TaskLog, ThreadPage, TokenInfo, Tombstone

RETRIES = 2
# Seconds between HTTP checks while the live socket is quiet or down.
POLL = 30
FINAL = ("answered", "expired", "cancelled")


class OriginConnection(connect):
    # Some supported websockets versions resend additional_headers on redirect.
    # Herald event streams must stay on the configured origin on every version.
    def process_redirect(self, error):
        return error


def path(value):
    return quote(value, safe="")


def file_name(header):
    """The file name from `Content-Disposition`, without any directory part."""
    encoded = re.search(r"filename\*=UTF-8''([^;]+)", header or "", re.I)
    plain = re.search(r'filename="([^"]*)"', header or "", re.I)
    name = unquote(encoded[1]) if encoded else plain[1] if plain else ""
    return re.split(r"[\\/]", name)[-1]


def wire(value):
    """Request JSON: models nested anywhere become their camelCase records."""
    if isinstance(value, BaseModel):
        return value.wire()
    if isinstance(value, dict):
        return {key: wire(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [wire(item) for item in value]
    return value


class Herald:
    def __init__(self, api_key=None, url=None, *, max_retry_after=60, transport=None, user_agent=None):
        self.url = (url or os.getenv("HERALD_URL", "https://app.herald.run")).rstrip("/")
        origin = urlparse(self.url)
        if origin.scheme != "https" and not (origin.scheme == "http" and origin.hostname in ("localhost", "127.0.0.1")):
            raise ValueError("Use HTTPS for Herald.")
        if origin.username or origin.password or origin.query or origin.fragment or origin.path not in ("", "/"):
            raise ValueError("Use a server URL without credentials, path, query or fragment.")
        token = (api_key or os.getenv("HERALD_API_KEY") or os.getenv("HERALD_TOKEN", "")).strip()
        # A keyed token (`hdr_<auth>.<seed>.<fingerprint>`) seals content; only `hdr_<auth>` is sent.
        # Anything shaped like one is parsed, so a malformed keyed token fails instead of leaking.
        keyed = token.startswith("hdr_") or re.search(r"\.[\w-]{43}\.[\w-]{22}$", token, re.ASCII)
        parsed = e2ee.parse_token(token) if keyed and "." in token else {"auth": token}
        self.key = parsed["auth"]
        self.keyed = KeyedSession(parsed["seed"], parsed["fingerprint"], lambda: self.request("/keys")) if "seed" in parsed else None
        # Longest server Retry-After, in seconds, that a request waits out before failing.
        self.max_retry_after = max_retry_after
        # `transport` replaces the network, e.g. with `httpx.MockTransport` in tests.
        self.user_agent = user_agent or "herald-python/" + __version__
        self.http = httpx.AsyncClient(timeout=15, follow_redirects=False, headers={"Authorization": "Bearer " + self.key, "User-Agent": self.user_agent}, transport=transport)
        # One socket shared by every wait() and watch() on this client.
        self.live = LiveSocket(self.socket)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()

    async def close(self):
        await self.http.aclose()

    async def request(self, path, body=None, *, method=None, idempotency_key=None, retry=True):
        """Calls `/api/v1` + `path`. Reads and keyed writes retry network errors and 5xx; any request
        retries a rate limit that sends Retry-After, since the server rejected it unprocessed."""
        response = await self._fetch("/api/v1" + path, body, method=method, idempotency_key=idempotency_key, retry=retry)
        return read_json(response, parse_retry_after(response.headers.get("Retry-After")))

    async def _fetch(self, path, body=None, *, method=None, idempotency_key=None, retry=True, stream=False):
        safe = body is None or bool(idempotency_key)
        retries = RETRIES if retry else 0
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else {}
        attempt = 0
        while True:
            try:
                request = self.http.build_request(method or ("GET" if body is None else "POST"), self.url + path, json=wire(body), headers=headers)
                response = await self.http.send(request, stream=stream)
            except httpx.TransportError:
                if attempt >= retries or not safe:
                    raise
                await asyncio.sleep(retry_delay(attempt))
                attempt += 1
                continue
            if 300 <= response.status_code < 400:
                await response.aclose()
                raise HeraldError("Herald does not accept API redirects.", response.status_code)
            retry_after = parse_retry_after(response.headers.get("Retry-After"))
            status = response.status_code
            again = (safe or retry_after is not None) if status == 429 else (status >= 500 and safe)
            if again and attempt < retries and (retry_after or 0) <= self.max_retry_after:
                await response.aclose()
                await asyncio.sleep(retry_delay(attempt) if retry_after is None else retry_after)
                attempt += 1
                continue
            return response

    async def ping(self):
        """Public liveness check; needs no token."""
        return Ping.model_validate(read_json(await self._fetch("/api/ping")))

    async def token(self):
        """The calling token's name, scopes and account."""
        return TokenInfo.model_validate(await self.request("/token"))

    async def revoke_token(self):
        """Revokes the calling token; later requests with it fail with 401."""
        await self.request("/token", method="DELETE")

    async def account(self):
        """Plan, usage and limits of the token's account."""
        return Account.model_validate(await self.request("/account"))

    @property
    def fingerprint(self):
        """The account safety code a keyed token is pinned to; None for legacy tokens."""
        return self.keyed and self.keyed.fingerprint

    async def _open(self, record, task=False):
        return await self.keyed.open_record(record, task) if self.keyed else record

    async def open_task(self, task):
        """Opens a task record received elsewhere, such as in a webhook delivery. Keyed clients flag a task without sealed input as `unverified`."""
        return Message.model_validate(await self._open(wire(task), True))

    async def send(self, *, idempotency_key=None, **message):
        """Keyed clients validate and seal the content, secret offers included."""
        idempotency_key = idempotency_key or str(uuid.uuid4())
        body = await self.keyed.seal_message(wire(message), idempotency_key) if self.keyed else message
        return Message.model_validate(await self._open(await self.request("/messages", body, idempotency_key=idempotency_key)))

    async def get(self, message_id):
        return Message.model_validate(await self._open(await self.request("/messages/" + path(message_id))))

    async def messages(self, **query):
        """One page of the revision feed (`after=`, with `Tombstone`s for `tombstones=1`), or
        messages matching `status`/`direction`."""
        search = urlencode({key: value for key, value in query.items() if value is not None})
        page = await self.request("/messages" + ("?" + search if search else ""))
        return [Tombstone.model_validate(m) if m.get("deleted") is True else Message.model_validate(await self._open(m)) for m in page]

    async def thread(self, message_id, *, after=0):
        page = await self.request("/messages/" + path(message_id) + "/thread?after=" + str(after))
        return ThreadPage.model_validate({**page, "messages": [await self._open(m) for m in page["messages"]]})

    async def thread_messages(self, message_id):
        after = 0
        while True:
            page = await self.thread(message_id, after=after)
            for message in page.messages:
                yield message
            if page.next is None:
                return
            after = page.next

    async def cancel(self, message_id):
        """Cancels a pending request this integration sent."""
        return Message.model_validate(await self._open(await self.request("/messages/" + path(message_id) + "/cancel", {})))

    async def task_logs(self, message_id, *, after=None):
        """A task's retained log lines after `after` (a sequence number)."""
        query = "" if after is None else "?after=" + str(int(after))
        page = await self.request(f"/messages/{path(message_id)}/logs{query}")
        logs = await self.keyed.open_logs(message_id, page["logs"], lambda: self.request("/messages/" + path(message_id))) if self.keyed else page["logs"]
        return [TaskLog.model_validate(log) for log in logs]

    async def download(self, file):
        """An attachment's name and bytes, from its ID or attachment. Keyed clients decrypt files
        whose key they hold, from an upload or an opened message."""
        given = {} if isinstance(file, str) else {k: v for k, v in wire(file).items() if v is not None}
        file_id = file if isinstance(file, str) else given["id"]
        known = {**(self.keyed.files.get(file_id, {}) if self.keyed else {}), **given}
        key = known.get("key")
        response = await self._fetch("/api/v1/files/" + path(file_id), stream=True)
        try:
            if response.is_error:
                await response.aread()
                raise_error(response, "File download failed.")
            data = await response.aread()
        finally:
            await response.aclose()
        name = file_name(response.headers.get("Content-Disposition")) or file_id
        if key:
            return FileDownload(name=known["name"], type=known["type"], data=b"".join(e2ee.open_file(key, data)))
        if self.keyed and name == "encrypted":
            raise e2ee.E2eeError("This file is end-to-end encrypted; download it through its attachment.")
        return FileDownload(name=name, type=response.headers.get("Content-Type", "application/octet-stream"), data=data)

    async def register(self, **destination):
        """Creates a destination, or updates the one registered with the same `key`."""
        return Destination.model_validate(await self.request("/destinations", destination))

    async def destinations(self):
        return [Destination.model_validate(d) for d in await self.request("/destinations")]

    async def update_destination(self, destination_id, **destination):
        return Destination.model_validate(await self.request("/destinations/" + path(destination_id), destination, method="PUT"))

    async def delete_destination(self, destination_id):
        """Removes a destination and cancels its queued tasks."""
        await self.request("/destinations/" + path(destination_id), method="DELETE")

    async def rotate_destination_secret(self, destination_id):
        """Replaces a webhook destination's signing secret, returned once."""
        return Destination.model_validate(await self.request(f"/destinations/{path(destination_id)}/secret", {}))

    async def claim_task(self, task_id, *, runner_id, heartbeat=False):
        """`heartbeat=True` asks for a lease that lapses unless renewed with `heartbeat_task`."""
        claim = await self.request(f"/tasks/{path(task_id)}/claim", {"runnerId": runner_id, "heartbeat": heartbeat})
        return TaskClaim.model_validate({**claim, "task": await self._open(claim["task"], True)})

    async def heartbeat_task(self, task_id, lease):
        return Lease.model_validate(await self.request(f"/tasks/{path(task_id)}/heartbeat", {"lease": lease}))

    async def update_task(self, task_id, *, lease=None, status=None, error=None, logs=None, idempotency_key=None, retry=True):
        """Reports logs and/or the outcome; keyed log batches retry safely."""
        update = {"lease": lease, "status": status, "error": error, "logs": logs}
        body = wire({key: value for key, value in update.items() if value is not None})
        if self.keyed:
            body = await self.keyed.seal_update(task_id, body)
        return Message.model_validate(await self._open(await self.request(f"/tasks/{path(task_id)}/update", body, idempotency_key=idempotency_key, retry=retry), True))

    async def collect_secrets(self, message_id):
        """Consumes the encrypted envelopes of an answered request's secret fields."""
        envelopes = await self.request(f"/messages/{path(message_id)}/secrets", {})
        # End-to-end envelopes (sealed to a keyed client) stay dicts.
        return {field: envelope if "ct" in envelope else Envelope.model_validate(envelope) for field, envelope in envelopes.items()}

    async def reveal_secrets(self, message_id, private_key=None):
        """`collect_secrets`, decrypted: end-to-end envelopes with this client's key, others with the
        private JWK whose public key the request carried."""
        values = {}
        for field, envelope in (await self.collect_secrets(message_id)).items():
            if isinstance(envelope, dict):
                if not self.keyed:
                    raise e2ee.E2eeError("Use a keyed token to open end-to-end secrets.")
                values[field] = await self.keyed.open_secret(message_id, field, envelope)
            elif private_key is None:
                raise ValueError("Pass the private key for this secret.")
            else:
                values[field] = unseal(envelope, private_key)
        return values

    async def secret_receiver(self, message_id):
        """For a `kind="secret"` offer: the receiver's claim and public key once a device claims it.
        Keyed clients accept only a key the account identity signed."""
        receiver = await self.request(f"/messages/{path(message_id)}/secret-receiver")
        return SecretReceiver.model_validate(await self.keyed.check_receiver(message_id, receiver) if self.keyed else receiver)

    async def deliver_secret(self, message_id, *, claim_id, envelope):
        """Deposits the value sealed to the claimed receiver's key; repeating the same deposit is safe."""
        await self.request(f"/messages/{path(message_id)}/secret-delivery", {"claimId": claim_id, "envelope": envelope})

    async def integrations(self):
        """Human sessions only: the account's connections."""
        return [Integration.model_validate(i) for i in await self.request("/integrations")]

    async def create_integration(self, *, name, scopes, certificate=None):
        """Human sessions only; the token is returned once. Not retried, so it never creates two.
        `certificate` certifies the connection's end-to-end key."""
        body = {"name": name, "scopes": scopes, **({"certificate": certificate} if certificate else {})}
        return CreatedIntegration.model_validate(await self.request("/integrations", body))

    async def keys(self):
        """The account statement and integration certificates; keyed clients return them verified."""
        return (await self.keyed.state())["directory"] if self.keyed else await self.request("/keys")

    async def device_certificate(self, user_code):
        """Human sessions only: the certificate an owner approved for a device login, once."""
        return await self.request("/keys/device-code/" + path(user_code))

    async def delete_integration(self, integration_id):
        """Human sessions only: revokes the token and removes the connection's destinations."""
        await self.request("/integrations/" + path(integration_id), method="DELETE")

    def socket(self):
        return OriginConnection(self.url.replace("http", "ws", 1) + "/ws", additional_headers={"Authorization": "Bearer " + self.key}, user_agent_header=self.user_agent, open_timeout=15)

    async def wait(self, message_id, *, wait_timeout=3600):
        if not 0 < wait_timeout <= 86400:
            raise ValueError("Wait timeout must be between zero and 24 hours.")
        event = self.live.subscribe()
        try:
            async with asyncio.timeout(wait_timeout):
                while True:
                    event.clear()
                    try:
                        message = await self.get(message_id)
                        if message.status in FINAL:
                            return message
                    except HeraldError as error:
                        if not retryable(error):
                            raise
                    except httpx.TransportError:
                        pass
                    try:
                        await asyncio.wait_for(event.wait(), POLL)
                    except TimeoutError:
                        pass
        except TimeoutError as error:
            raise HeraldError("Wait timed out; resume with the message ID. The request remains available.", 408, message_id) from error
        finally:
            self.live.unsubscribe(event)

    async def ask(self, *, title, schema=None, timeout=None, wait_timeout=3600, idempotency_key=None, **message):
        result, model = await self._answer(title=title, schema=schema, timeout=timeout, wait_timeout=wait_timeout, idempotency_key=idempotency_key, **message)
        values = result.response.values
        return model.model_validate(values) if model else values

    async def ask_action(self, *, title, actions, schema=None, timeout=None, wait_timeout=3600, idempotency_key=None, **message):
        if not actions:
            raise ValueError("ask_action requires declared actions.")
        result, model = await self._answer(title=title, actions=actions, schema=schema, timeout=timeout, wait_timeout=wait_timeout, idempotency_key=idempotency_key, **message)
        action_id = result.response and result.response.action_id
        if not action_id or not any(action["id"] == action_id for action in actions):
            raise HeraldError("The response does not identify a declared action.", 502, result.id)
        values = result.response.values
        return ActionAnswer(action_id=action_id, values=model.model_validate(values) if model else values)

    async def _answer(self, *, title, schema=None, timeout=None, wait_timeout=3600, idempotency_key=None, **message):
        model = schema if isinstance(schema, type) and issubclass(schema, BaseModel) else None
        if schema is not None:
            message["schema"] = model.model_json_schema() if model else schema
        if timeout is not None:
            if not isinstance(timeout, (float, int)) or not 0 < timeout <= 86400:
                raise ValueError("Timeout must be seconds between zero and 24 hours.")
            if "expiresAt" in message or "expiresIn" in message:
                raise ValueError("Use timeout or expiresAt, not both.")
            message["expiresIn"] = timeout
        sent = await self.send(title=title, kind="form", idempotency_key=idempotency_key, **message)
        result = await self.wait(sent.id, wait_timeout=wait_timeout)
        if result.status != "answered":
            raise HeraldError("Request " + result.status + ".", 410, sent.id)
        if result.locked or result.unverified:
            raise HeraldError("The answer could not be verified.", 502, sent.id)
        return result, model

    async def watch(self, *, after=0):
        if not isinstance(after, int) or after < 0:
            raise ValueError("Use a nonnegative revision.")
        event = self.live.subscribe()
        try:
            while True:
                event.clear()
                try:
                    page = await self.messages(after=after)
                except (HeraldError, httpx.TransportError) as error:
                    if isinstance(error, HeraldError) and not retryable(error):
                        raise
                    await asyncio.sleep(3)
                    continue
                for message in page:
                    yield message
                    after = max(after, message.revision or 0)
                if len(page) == 100:
                    continue
                try:
                    await asyncio.wait_for(event.wait(), POLL)
                except TimeoutError:
                    pass
        finally:
            self.live.unsubscribe(event)

    async def upload(self, name, data, content_type="application/octet-stream", *, size=None, idle_timeout=60):
        """Reserves and uploads bytes or an async iterable of bytes (pass `size`); aborts only
        after `idle_timeout` seconds without progress."""
        key = None
        if self.keyed:
            # Keyed uploads are encrypted in memory; the server sees only the sealed size.
            plain = bytes(data) if isinstance(data, (bytes, bytearray)) else b"".join([bytes(c) async for c in data])
            key, size = e2ee.file_key(), len(plain)
            data = b"".join(e2ee.seal_file(key, plain))
        if isinstance(data, (bytes, bytearray)):
            size = len(data) if key is None else size
            sealed_size, data = len(data), chunks(data)
        else:
            sealed_size = size
        if not isinstance(size, int) or size < 0:
            raise ValueError("Pass the byte size for streamed uploads.")
        reserve = {"name": "encrypted", "type": "application/octet-stream", "size": sealed_size} if key else {"name": name, "type": content_type, "size": size}
        file = Attachment.model_validate(await self.request("/files", reserve))
        response = await self.http.put(self.url + "/api/v1/files/" + path(file.id), content=idle_body(data, idle_timeout), headers={"Content-Length": str(sealed_size)}, timeout=idle_timeout)
        if not response.is_success:
            raise_error(response, "File upload failed.")
        if key is None:
            return Attachment(id=file.id, name=file.name, size=file.size, type=file.type)
        self.keyed.files[file.id] = {"id": file.id, "name": name, "type": content_type, "size": size, "key": key}
        return Attachment(id=file.id, name=name, size=size, type=content_type, key=key)
