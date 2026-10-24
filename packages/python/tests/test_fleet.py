"""Fleet reporting: sealed unit states bound to account, world and key; worlds, removal and refs."""
import json
import unittest
from pathlib import Path

import httpx
from herald import FleetWorld, Herald, HeraldError, SyncHerald, e2ee
from fixtures import SCENARIO, keyed

V = json.loads((Path(__file__).parents[2] / "sdk/fixtures/e2ee-vectors.json").read_text())
W = V["workspace"]
WORLD = {"id": "fw_1", "repo": {"id": 1, "fullName": "Acme/App", "url": "", "defaultBranch": "main", "private": True}, "createdAt": "2026-01-01T00:00:00.000Z"}
STATE = {"name": "app (main)", "kind": "claude-code", "activity": "editing", "files": ["src/a.ts"]}


def routes(seen, replies):
    def handle(request):
        seen.append((request.method, request.url.path, json.loads(request.content) if request.content else None))
        reply = replies.get(f"{request.method} {request.url.path}")
        return reply if isinstance(reply, httpx.Response) else httpx.Response(200, json=reply) if reply is not None else httpx.Response(404, json={"error": "Not found."})
    return handle


class FleetTests(unittest.IsolatedAsyncioTestCase):
    async def test_seals_units_to_the_account_bound_to_world_and_key(self):
        seen = []
        async with keyed(routes(seen, {"POST /api/v1/fleet/worlds/fw_1/units": {"units": [{"key": "k1", "expiresAt": "x"}]}})) as herald:
            result = await herald.fleet_report("fw_1", [{"key": "k1", "state": {**STATE, "extra": 1}}])
        self.assertEqual(result["units"][0]["key"], "k1")
        unit = seen[-1][2]["units"][0]
        self.assertEqual((unit["key"], unit["ttl"]), ("k1", 600))
        account = SCENARIO["keyring"]["account"]
        self.assertEqual(unit["sealed"]["ctx"], {"t": "fleet-unit", "account": account, "world": "fw_1", "key": "k1"})
        owner = e2ee.keyring_keys(SCENARIO["keyring"])
        me = e2ee.key_set(e2ee.parse_token(SCENARIO["token"])["seed"])
        payload = e2ee.open(unit["sealed"], recipients=[owner.inbox[0]], signers=lambda kid: me.sign_pub if kid == me.kid else None, expect={"t": "fleet-unit", "account": account, "world": "fw_1", "key": "k1"})
        self.assertEqual(payload, {"v": 1, **STATE, "files": ["src/a.ts"]})
        with self.assertRaises(Exception):
            e2ee.open(unit["sealed"], recipients=[owner.inbox[0]], signers=lambda kid: me.sign_pub, expect={"t": "fleet-unit", "account": account, "world": "fw_2", "key": "k1"})

    async def test_validates_before_sending(self):
        seen = []
        async with keyed(routes(seen, {})) as herald:
            for units, text in [
                ([{"key": "bad key", "state": STATE}], "Unit keys"),
                ([{"key": "k", "state": {**STATE, "name": " "}}], "name"),
                ([{"key": "k", "state": STATE}] * 2, "unique"),
                ([], "1 to 50"),
                ([{"key": "k", "ttl": 5, "state": STATE}], "ttl"),
                ([{"key": "k", "state": {**STATE, "area": "Bad Area"}}], "area"),
                ([{"key": "k", "state": {**STATE, "files": [f"{i}".ljust(300, "é") for i in range(10)]}}], "exceeds 6,000"),
            ]:
                with self.subTest(text), self.assertRaisesRegex(HeraldError, text):
                    await herald.fleet_report("fw_1", units)
            # Unknown kinds and activities read as viewers would.
            [unit] = await herald.fleet_units("fw_1", [{"key": "k", "state": {"name": "x", "kind": "Bad!", "activity": "dancing"}}])
            self.assertEqual(unit["sealed"]["ctx"]["key"], "k")
        self.assertFalse([s for s in seen if s[0] == "POST"])

    async def test_worlds_remove_track_and_quota_errors(self):
        seen = []
        paused = httpx.Response(429, json={"error": "Used up.", "code": "FLEET_QUOTA", "resetsAt": "2026-02-01T00:00:00.000Z"}, headers={"Retry-After": "86400"})
        handle = routes(seen, {
            "GET /api/v1/fleet": {"worlds": [WORLD]},
            "DELETE /api/v1/fleet/worlds/fw_1/units/k1": httpx.Response(204),
            "PUT /api/v1/fleet/worlds/fw_1/refs": httpx.Response(202, json={"ok": True}),
            "POST /api/v1/fleet/worlds/fw_1/units": paused,
        })
        async with keyed(handle) as herald:
            worlds = await herald.fleet_worlds()
            self.assertIsInstance(worlds[0], FleetWorld)
            self.assertEqual((worlds[0].repo.full_name, worlds[0].repo.default_branch), ("Acme/App", "main"))
            self.assertEqual((await herald.fleet_world("acme/app")).id, "fw_1")
            self.assertIsNone(await herald.fleet_world("acme/other"))
            await herald.fleet_remove("fw_1", "k1")
            await herald.fleet_track("fw_1", "feature/x")
            with self.assertRaises(HeraldError):
                await herald.fleet_track("fw_1", "")
            with self.assertRaises(HeraldError) as caught:
                await herald.fleet_report("fw_1", [{"key": "k1", "state": STATE}])
        self.assertEqual((caught.exception.status, caught.exception.code, caught.exception.resets_at), (429, "FLEET_QUOTA", "2026-02-01T00:00:00.000Z"))
        self.assertIn(("PUT", "/api/v1/fleet/worlds/fw_1/refs", {"ref": "feature/x"}), seen)
        self.assertIn(("DELETE", "/api/v1/fleet/worlds/fw_1/units/k1", None), seen)

    async def test_seals_to_the_default_team_in_a_team_workspace(self):
        integration = next(s for s in V["keySets"] if s["name"] == "integration")
        token = e2ee.format_token("hdr_ws-test", integration["seed"], W["fingerprint"])
        directory = {"account": None, "certificates": [{**c["certificate"], "integrationId": c["name"]} for c in W["certificates"]], "workspace": {"chain": W["chain"], "roster": W["roster"]}}
        posts = []

        def handle(request):
            if request.url.path == "/api/v1/keys":
                return httpx.Response(200, json=directory)
            posts.append(json.loads(request.content))
            return httpx.Response(200, json={"units": []})
        async with Herald(api_key=token, url="https://herald.test", transport=httpx.MockTransport(handle), workspace=W["workspace"]) as herald:
            await herald.fleet_report("fw_1", [{"key": "k1", "state": STATE}])
        sealed = posts[0]["units"][0]["sealed"]
        self.assertEqual(sealed["ctx"], {"t": "fleet-unit", "account": W["workspace"], "world": "fw_1", "key": "k1", "team": "team-ops"})
        self.assertEqual([r["kid"] for r in sealed["to"]], [W["teams"]["ops"][1], integration["kid"]])

    def test_sync_wrapper(self):
        seen = []
        with keyed(routes(seen, {"GET /api/v1/fleet": {"worlds": [WORLD]}}), SyncHerald) as herald:
            self.assertEqual(herald.fleet_worlds()[0].id, "fw_1")


if __name__ == "__main__":
    unittest.main()
