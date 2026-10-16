"""Keyed tokens: only the auth part is sent, content is sealed, and anything unverifiable fails closed."""
import json
import unittest
from pathlib import Path

import httpx
from pydantic import BaseModel
from herald import Herald, HeraldError, SyncHerald, e2ee

SCENARIO = json.loads((Path(__file__).parents[2] / "sdk/fixtures/contracts.json").read_text())["e2ee"]
STEP = {s["name"]: s for s in SCENARIO["steps"]}
DIRECTORY, SENT = STEP["keys"]["response"]["body"], STEP["send"]["response"]["body"]
TOKEN = SCENARIO["token"]


def client(routes, seen, cls=Herald):
    def handle(request):
        seen.append(request)
        for route, reply in routes.items():
            if f"{request.method} {request.url.path}".startswith(route):
                return reply if isinstance(reply, httpx.Response) else httpx.Response(200, json=reply)
        return httpx.Response(404, json={"error": "Not found."})
    return cls(api_key=TOKEN, url="https://herald.test", transport=httpx.MockTransport(handle))


def answered(values):
    owner = e2ee.keyring_keys(SCENARIO["keyring"])
    runner = DIRECTORY["certificates"][0]["certificate"]
    ctx = {"t": "response", "account": SCENARIO["keyring"]["account"], "message": SENT["id"], "request": e2ee.envelope_digest(SENT["sealed"])}
    to = [{"kid": owner.inbox_kid, "box": owner.inbox[0].box_pub}, {"kid": runner["kid"], "box": runner["box"]}]
    sealed = e2ee.seal(payload={"values": values}, ctx=ctx, signer=owner.identity, to=to)
    return {**SENT, "status": "answered", "response": {"values": {}, "secretFields": [], "sealed": sealed}}


class Choice(BaseModel):
    approve: bool


class KeyedTests(unittest.IsolatedAsyncioTestCase):
    async def test_sends_only_the_auth_part_and_seals_content(self):
        seen = []
        async with client({"GET /api/v1/keys": DIRECTORY, "POST /api/v1/messages": SENT}, seen) as herald:
            self.assertEqual((herald.key, herald.fingerprint), ("hdr_test-only", TOKEN.split(".")[2]))
            await herald.send(title="Hello", body="World")
            await herald.send(title="Pick", kind="form", schema=Choice.model_json_schema())
        self.assertEqual({r.headers["Authorization"] for r in seen}, {"Bearer hdr_test-only"})
        self.assertFalse(any(b"World" in r.content or TOKEN.split(".")[1].encode() in r.content for r in seen))
        self.assertTrue(json.loads(seen[-1].content)["asks"])
        with self.assertRaises(e2ee.E2eeError):
            Herald(api_key="hdr_x.short.fp")
        self.assertIsNone(Herald(api_key="hdr_legacy").keyed)
        # Surrounding whitespace or a missing prefix never sends the seed.
        self.assertEqual(Herald(api_key=f"  {TOKEN}\n").key, "hdr_test-only")
        self.assertEqual(Herald(api_key=TOKEN[4:]).key, "test-only")
        self.assertIsNone(Herald(api_key="a.b.c").keyed)

    async def test_fails_closed(self):
        for keys in [{"account": None, "certificates": []}, {**DIRECTORY, "certificates": []}, {**DIRECTORY, "account": e2ee.account_statement(e2ee.create_keyring("acct-contracts"))}]:
            seen = []
            async with client({"GET /api/v1/keys": keys, "POST /api/v1/messages": SENT}, seen) as herald:
                with self.assertRaises(e2ee.E2eeError):
                    await herald.send(title="Hello")
            self.assertEqual([r.method for r in seen], ["GET"])

    async def test_validates_input_and_answers(self):
        seen = []
        routes = {"GET /api/v1/keys": DIRECTORY, "POST /api/v1/messages": SENT, "GET /api/v1/messages/": answered({"approve": "yes"})}
        async with client(routes, seen) as herald:
            for bad in [{"title": ""}, {"title": "x", "fields": [{"id": "a", "type": "select", "label": "A"}]}]:
                with self.assertRaises(HeraldError):
                    await herald.send(**bad)
            with self.assertRaisesRegex(e2ee.E2eeError, "too large to encrypt"):
                await herald.send(title="Big", body="\u4e2d" * 50000)
            await herald.send(title="Key", kind="secret")
            posted = json.loads([r for r in seen if r.method == "POST"][-1].content)
            self.assertEqual((posted["kind"], posted["asks"], posted["attachments"]), ("secret", False, []))
            self.assertNotIn("Key", json.dumps(posted))
            self.assertEqual(posted["sealed"]["ctx"], {"t": "message", "account": SCENARIO["keyring"]["account"], "id": posted["id"]})
            opened = await herald.get(SENT["id"])
            self.assertEqual((opened.unverified, opened.response.values), (True, {}))
            with self.assertRaises(HeraldError):
                await herald.ask(title="Deploy?", schema=Choice)

    async def test_opens_tasks_and_refuses_encrypted_downloads_without_a_key(self):
        claim = STEP["claim-task"]
        routes = {"GET /api/v1/keys": DIRECTORY, "GET /api/v1/files/": httpx.Response(200, content=b"x", headers={"Content-Disposition": 'attachment; filename="encrypted"'})}
        async with client(routes, []) as herald:
            task = await herald.open_task(claim["response"]["body"]["task"])
            self.assertEqual(task.wire(), claim["result"]["task"])
            with self.assertRaisesRegex(e2ee.E2eeError, "end-to-end encrypted"):
                await herald.download("00000000-0000-4000-8000-0000000000ff")

    async def test_binds_logs_and_results_to_the_runner_and_refuses_unsealed_tasks(self):
        raw = STEP["claim-task"]["response"]["body"]["task"]
        other = e2ee.key_set()
        cert = e2ee.certify(SCENARIO["keyring"], sign=other.sign_pub, box=other.box_pub)
        keys = {**DIRECTORY, "certificates": [*DIRECTORY["certificates"], {"integrationId": "00000000-0000-4000-8000-0000000000aa", **cert}]}
        owner = e2ee.keyring_keys(SCENARIO["keyring"])
        to = [{"kid": owner.inbox_kid, "box": owner.inbox[0].box_pub}]
        account = SCENARIO["keyring"]["account"]
        forged = e2ee.seal(payload={"error": "forged"}, ctx={"t": "result", "account": account, "task": raw["id"]}, signer=other, to=to)
        log = e2ee.seal(payload={"text": "forged"}, ctx={"t": "log", "account": account, "task": raw["id"], "seq": 0}, signer=other, to=to)
        logs = {"logs": [{"sequence": 0, "stream": "stdout", "text": "", "sealed": log}, {"sequence": 1, "stream": "stdout", "text": "plain"}]}
        routes = {"GET /api/v1/keys": keys, f"GET /api/v1/messages/{raw['id']}/logs": logs, f"GET /api/v1/messages/{raw['id']}": raw}
        async with client(routes, []) as herald:
            failed = {**raw, "result": {"status": "failed", "completedAt": raw["createdAt"], "sealed": forged}}
            self.assertTrue((await herald.open_task(failed)).unverified)
            self.assertEqual([(entry.text, entry.unverified) for entry in await herald.task_logs(raw["id"])], [("", True), ("", True)])
            plain = await herald.open_task({**raw, "input": {**{k: v for k, v in raw["input"].items() if k != "sealed"}, "values": {"prompt": "rm -rf"}}})
            self.assertEqual((plain.unverified, plain.input.values, plain.response.values), (True, {}, {}))
            injected = await herald.open_task({**raw, "session": {"prompt": "injected"}, "response": {**raw["response"], "actionId": "x"}})
            self.assertNotIn("session", injected.wire())
            self.assertIsNone(injected.response.action_id)

    def test_sync_wrapper(self):
        with client({"GET /api/v1/keys": DIRECTORY, "GET /api/v1/messages/": STEP["get"]["response"]["body"]}, [], SyncHerald) as herald:
            self.assertEqual(herald.get(SENT["id"]).title, "Deploy v2?")
