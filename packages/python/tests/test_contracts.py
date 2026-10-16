"""The Python side of the shared contract fixtures (packages/sdk/fixtures/contracts.ts)."""
import json
import re
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote

import httpx
from pydantic import BaseModel
from herald import Envelope, Herald, HeraldError, TaskLog, e2ee

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


def plain(value, top=True):
    """SDK results as JSON; methods for `{ok: true}` replies return None."""
    if value is None:
        return {"ok": True} if top else None
    if isinstance(value, BaseModel):
        return value.wire()
    if isinstance(value, list):
        return [plain(v, False) for v in value]
    if isinstance(value, dict):
        return {k: plain(v, False) for k, v in value.items()}
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
    "keys": lambda h, a: h.keys(),
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


def like(expected, actual):
    """`<string>` in a sealed step's result matches any string."""
    if expected == "<string>":
        return isinstance(actual, str)
    if isinstance(expected, dict):
        return isinstance(actual, dict) and expected.keys() == actual.keys() and all(like(v, actual[k]) for k, v in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(expected) == len(actual) and all(map(like, expected, actual))
    return expected == actual


def at(value, dotted):
    for key in dotted.split("."):
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


async def bytes_of(download):
    return (await download).data.decode()


SEALED = {
    "keys": lambda h, s, i: h.keys(),
    "upload": lambda h, s, i: h.upload("notes.txt", b"hello", "text/plain"),
    "send": lambda h, s, i: h.send(idempotency_key=s["request"]["headers"]["Idempotency-Key"], **s["input"]),
    "get": lambda h, s, i: h.get(i),
    "thread": lambda h, s, i: h.thread(i),
    "get-tampered": lambda h, s, i: h.get(i),
    "get-locked": lambda h, s, i: h.get(i),
    "send-secret-form": lambda h, s, i: h.send(idempotency_key=s["request"]["headers"]["Idempotency-Key"], **s["input"]),
    "collect-secrets": lambda h, s, i: h.reveal_secrets(i),
    "claim-task": lambda h, s, i: h.claim_task(i, runner_id=s["request"]["body"]["runnerId"], heartbeat=s["request"]["body"]["heartbeat"]),
    "task-logs": lambda h, s, i: h.update_task(i, idempotency_key=s["request"]["headers"]["Idempotency-Key"], **s["input"]),
    "read-task-logs": lambda h, s, i: logs_of(h.task_logs(i)),
    "complete-task": lambda h, s, i: h.update_task(i, **s["input"]),
    "download": lambda h, s, i: bytes_of(h.download(s["input"])),
    "offer-secret": lambda h, s, i: h.send(idempotency_key=s["request"]["headers"]["Idempotency-Key"], **s["input"]),
    "secret-receiver": lambda h, s, i: h.secret_receiver(i),
    "secret-receiver-forged": lambda h, s, i: h.secret_receiver(i),
}


class SealedContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_keyed_scenario(self):
        scenario = FIXTURES["e2ee"]
        self.assertEqual(list(SEALED), [s["name"] for s in scenario["steps"]])
        owner = e2ee.keyring_keys(scenario["keyring"])
        cert = scenario["steps"][0]["response"]["body"]["certificates"][0]["certificate"]
        seed = e2ee.parse_token(scenario["token"])["seed"]
        replies, seen = [], []

        async def handle(request):
            raw = await request.aread()
            self.assertEqual(request.headers["Authorization"], "Bearer hdr_test-only")
            self.assertNotIn(seed.encode(), raw)
            seen.append({"method": request.method, "path": unquote(request.url.raw_path.decode()), "headers": request.headers, "raw": raw})
            reply = replies.pop(0)
            if isinstance(reply["body"], bytes):
                return httpx.Response(reply["status"], content=reply["body"])
            return httpx.Response(reply["status"], json=reply["body"])

        async with Herald(api_key=scenario["token"], url="https://herald.test", transport=httpx.MockTransport(handle)) as client:
            for step in scenario["steps"]:
                name, request = step["name"], step["request"]
                reply = {**step["response"], "body": e2ee.b64u_decode(step["response"]["body"])} if step.get("bytes") else step["response"]
                replies[:] = [reply] + ([step["upload"]["response"]] if "upload" in step else [])
                parts = request["path"].split("/")
                with self.subTest(name):
                    call = SEALED[name](client, step, unquote(parts[4]) if len(parts) > 4 else "")
                    if "error" in step:
                        with self.assertRaisesRegex(Exception, re.escape(step["error"])):
                            await call
                        result = None
                    else:
                        result = plain(await call)
                        self.assertTrue(like(step["result"], result), (result, step["result"]))
                    sent = seen.pop(0)
                    self.assertEqual((sent["method"], sent["path"]), (request["method"], request["path"]))
                    for header, value in request.get("headers", {}).items():
                        self.assertEqual(sent["headers"].get(header), value)
                    body = json.loads(sent["raw"]) if sent["raw"] else None
                    want = json.loads(json.dumps(request.get("body")))
                    for dotted, payload in step.get("sealed", {}).items():
                        mine, theirs = at(body, dotted), at(want, dotted)
                        opened = e2ee.open(mine, recipients=[owner.inbox[0]], signers=lambda kid: cert["sign"] if kid == cert["kid"] else None, expect={"t": theirs["ctx"]["t"], "account": scenario["keyring"]["account"]})
                        self.assertEqual(opened, payload)
                        self.assertEqual({**mine["ctx"], "cid": 0}, {**theirs["ctx"], "cid": 0})
                        self.assertEqual([r["kid"] for r in mine["to"]], [r["kid"] for r in theirs["to"]])
                        *parent, leaf = dotted.split(".")
                        leaf = int(leaf) if leaf.isdigit() else leaf
                        (at(body, ".".join(parent)) if parent else body)[leaf] = None
                        (at(want, ".".join(parent)) if parent else want)[leaf] = None
                    self.assertEqual(body, want)
                    if "upload" in step:
                        put = seen.pop(0)
                        self.assertEqual((put["method"], put["path"]), ("PUT", step["upload"]["path"]))
                        self.assertEqual(len(put["raw"]), e2ee.sealed_size(len(step["upload"]["plain"])))
                        self.assertEqual(b"".join(e2ee.open_file(result["key"], put["raw"])).decode(), step["upload"]["plain"])
                    self.assertEqual(seen, [])
