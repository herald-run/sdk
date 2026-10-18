"""Python side of the shared end-to-end vectors (packages/sdk/fixtures/e2ee-vectors.json): reproduce every output, open every input."""
import hashlib
import json
import re
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from herald import e2ee
from herald.e2ee import E2eeError, b64u_decode, b64u_encode

V = json.loads((Path(__file__).parents[2] / "sdk/fixtures/e2ee-vectors.json").read_text())
ACCOUNT = V["keyring"]["value"]["account"]


def pattern(size):
    return bytes((i * 7) % 251 for i in range(size))


@contextmanager
def draws(values):
    """Replays recorded random draws in order, then checks all were used."""
    queue = [b64u_decode(v) for v in values]

    def take(length):
        value = queue.pop(0)
        assert len(value) == length, (len(value), length)
        return value

    with mock.patch.object(e2ee, "_random", take), mock.patch.object(e2ee, "_now", lambda: V["now"]):
        yield
    assert not queue, "unused draws"


class Setup:
    keys = e2ee.keyring_keys(V["keyring"]["value"])
    sets = {s["name"]: e2ee.key_set(s["seed"]) for s in V["keySets"]}
    info = e2ee.verify_account(V["statement"], V["keyring"]["fingerprint"], ACCOUNT)
    sign_pubs = {"account": info.identity}
    for c in V["certificates"]:
        sign_pubs[c["name"]] = e2ee.verify_certificate(c["certificate"], info.identity, ACCOUNT)["sign"]
    kids = {"account": info.signer_kid, "integration": sets["integration"].kid, "destination": sets["destination"].kid}
    openers = {"inbox": keys.inbox[0], **sets}
    recipients = {"inbox": {"kid": info.inbox_kid, "box": info.inbox}, **{n: {"kid": s.kid, "box": s.box_pub} for n, s in sets.items()}}
    signer_keys = {"account": keys.identity, **sets}

    def signers(self, names):
        return lambda kid: next((self.sign_pubs[n] for n in names if self.kids[n] == kid), None)


S = Setup()
ALL = ["account", "integration", "destination"]


class PrimitiveTests(unittest.TestCase):
    def test_canon_hash_and_base64url(self):
        for case in V["canon"]:
            self.assertEqual(e2ee.canon(case["value"]), case["canon"])
        for bad in [float("nan"), float("inf"), 2**53, 1e21, {1: 2}, b"x", object()]:
            with self.assertRaises(E2eeError, msg=repr(bad)):
                e2ee.canon(bad)
        self.assertEqual(e2ee.canon([1.0, -0.0, 1.5e300 / 1e300, 5e-324]), "[1,0,1.5,5e-324]")
        for case in V["hash"]:
            self.assertEqual(b64u_encode(e2ee.H(case["label"], *map(b64u_decode, case["parts"]))), case["digest"])
        self.assertEqual(b64u_decode("-_8"), bytes([251, 255]))
        for bad in ["-_9", "+/8", "AA==", "A", "AA A", "AA\n"]:
            with self.assertRaises(E2eeError, msg=bad):
                b64u_decode(bad)

    def test_hpke_known_answers(self):
        for case in V["hpke"]:
            h = bytes.fromhex
            sk_r, pk_r = e2ee._derive_key_pair(h(case["ikmR"]))
            self.assertEqual(pk_r.hex(), case["pkR"])
            with mock.patch.object(e2ee, "_random", lambda n: h(case["ikmE"])):
                enc, ct = e2ee._hpke_seal(pk_r, h(case["info"]), h(case["aad"]), h(case["pt"]), case["aead"])
            self.assertEqual((enc.hex(), ct.hex()), (case["enc"], case["ct"]))
            self.assertEqual(e2ee._hpke_open(sk_r, pk_r, enc, h(case["info"]), h(case["aad"]), ct, case["aead"]).hex(), case["pt"])
            with self.assertRaises(E2eeError):
                e2ee._hpke_open(sk_r, pk_r, enc, h(case["info"]), b"", ct, case["aead"])


class KeyTests(unittest.TestCase):
    def test_reproduces_keys_statement_and_certificates(self):
        for s in V["keySets"]:
            got = e2ee.key_set(s["seed"])
            self.assertEqual((got.kid, got.sign_pub, got.box_pub), (s["kid"], s["signPub"], s["boxPub"]))
        with draws(V["keyring"]["random"]):
            self.assertEqual(e2ee.create_keyring(ACCOUNT), V["keyring"]["value"])
        self.assertEqual((S.keys.signer_kid, S.keys.inbox_kid), (V["keyring"]["signerKid"], V["keyring"]["inboxKid"]))
        self.assertEqual(e2ee.fingerprint(S.keys.identity.sign_pub), V["keyring"]["fingerprint"])
        self.assertEqual(e2ee.safety_code(V["keyring"]["fingerprint"]), V["keyring"]["safetyCode"])
        self.assertEqual(e2ee.safety_code("A" * 22), "00000 00000 00000 00000 00000 00000")
        self.assertEqual(e2ee.account_statement(V["keyring"]["value"]), V["statement"])
        with draws([]):
            for c in V["certificates"]:
                s = S.sets[c["name"]]
                self.assertEqual(e2ee.certify(V["keyring"]["value"], sign=s.sign_pub, box=s.box_pub), c["certificate"])
        with self.assertRaisesRegex(E2eeError, "fingerprint mismatch"):
            e2ee.verify_account(V["statement"], "A" * 22)
        moved = {**V["statement"], "statement": {**V["statement"]["statement"], "account": "x"}}
        with self.assertRaisesRegex(E2eeError, "Bad statement signature"):
            e2ee.verify_account(moved, V["keyring"]["fingerprint"])
        cert = V["certificates"][0]["certificate"]
        with self.assertRaisesRegex(E2eeError, "account mismatch"):
            e2ee.verify_certificate(cert, S.info.identity, "x")
        with self.assertRaisesRegex(E2eeError, "Bad certificate signature"):
            e2ee.verify_certificate(cert, S.sets["integration"].sign_pub, ACCOUNT)

    def test_receiver_and_tokens(self):
        claim = V["receiver"]["claim"]
        args = dict(message=claim["message"], claim_id=claim["claimId"], public_key=claim["publicKey"])
        self.assertEqual(e2ee.sign_receiver(V["keyring"]["value"], **args), V["receiver"]["sig"])
        e2ee.verify_receiver(V["receiver"]["sig"], S.info.identity, **args)
        with self.assertRaisesRegex(E2eeError, "Bad receiver"):
            e2ee.verify_receiver(V["receiver"]["sig"], S.info.identity, **{**args, "claim_id": "other"})
        for case in V["tokens"]:
            self.assertEqual(e2ee.parse_token(case["token"]), case["parsed"])
        parsed = V["tokens"][0]["parsed"]
        self.assertEqual(e2ee.format_token(parsed["auth"], parsed["seed"], parsed["fingerprint"]), V["tokens"][0]["token"])
        for bad in ["", "hdr_a.b", V["tokens"][0]["token"] + ".x", "hdr_a." + parsed["seed"] + ".AAAA"]:
            with self.assertRaises(E2eeError, msg=bad):
                e2ee.parse_token(bad)


MSG_ID = "6f1c1a4e-58d3-4f9c-9a38-7f0d1c2b3a4d"


class EnvelopeTests(unittest.TestCase):
    def test_reproduces_and_opens_every_context_type(self):
        for case in V["envelopes"]:
            with draws(case["random"]):
                env = e2ee.seal(payload=case["payload"], ctx=case["ctx"], signer=S.signer_keys[case["signer"]], to=[S.recipients[n] for n in case["to"]])
            self.assertEqual(env, case["envelope"], case["name"])
            for name in case["to"]:
                got = e2ee.open(case["envelope"], recipients=[S.openers[name]], signers=S.signers(ALL), expect=case["envelope"]["ctx"])
                self.assertEqual(got, {"v": 1, **case["payload"]})
        self.assertEqual(V["envelopes"][1]["ctx"]["request"], e2ee.envelope_digest(V["envelopes"][0]["envelope"]))

    def test_rejects_every_negative_case(self):
        for case in V["negative"]:
            with self.assertRaisesRegex(E2eeError, case["error"], msg=case["name"]):
                e2ee.open(case["envelope"], recipients=[S.openers[n] for n in case["recipients"]], signers=S.signers(case["trusted"]), expect=case["expect"])

    def test_seal_validates_contexts_and_payloads(self):
        signer, to = S.sets["integration"], [S.recipients["inbox"]]
        msg = {"t": "message", "account": ACCOUNT, "id": MSG_ID}
        bad = [({"t": "nope", "account": ACCOUNT}, "Unknown context"), ({"t": "log", "account": ACCOUNT, "task": "x", "seq": True}, "ctx.seq"), ({"t": "result", "account": ACCOUNT, "task": "x", "extra": "y"}, "Unexpected ctx.extra")]
        bad += [({"t": "message", "account": ACCOUNT}, "ctx.id"), ({**msg, "id": "not-a-uuid"}, "ctx.id"), ({"t": "task", "account": ACCOUNT, "destination": "d", "type": "x"}, "ctx.id")]
        for ctx, error in bad:
            with self.assertRaisesRegex(E2eeError, error):
                e2ee.seal(payload={}, ctx=ctx, signer=signer, to=to)
        with self.assertRaisesRegex(E2eeError, "version"):
            e2ee.seal(payload={"v": 2}, ctx=msg, signer=signer, to=to)
        with self.assertRaisesRegex(E2eeError, "too large to encrypt"):
            e2ee.seal(payload={"body": "\u4e2d" * 50000}, ctx=msg, signer=signer, to=to)
        env = e2ee.seal(payload={"x": 1}, ctx=msg, signer=signer, to=to)
        self.assertEqual(e2ee.open(env, recipients=S.keys.inbox, signers=S.signers(ALL), expect={"t": "message", "account": ACCOUNT}), {"v": 1, "x": 1})
        with self.assertRaisesRegex(E2eeError, "Context mismatch: id"):
            e2ee.open(env, recipients=S.keys.inbox, signers=S.signers(ALL), expect={**msg, "id": "00000000-0000-4000-8000-000000000000"})

    def test_grant_and_idempotency(self):
        message = V["envelopes"][0]
        cek = e2ee.open_key(message["envelope"], S.keys.inbox)
        with draws(V["grant"]["random"]):
            self.assertEqual(e2ee.grant(message["envelope"], cek, S.recipients["destination"]), V["grant"]["recipient"])
        granted = {**message["envelope"], "to": [V["grant"]["recipient"]]}
        self.assertEqual(e2ee.open(granted, recipients=[S.sets["destination"]], signers=S.signers(ALL), expect=granted["ctx"]), {"v": 1, **message["payload"]})
        for case in V["idempotency"]:
            self.assertEqual(e2ee.idempotency_digest(S.sets[case["name"]].seed, case["payload"], case["key"]), case["digest"])
        self.assertNotEqual(V["idempotency"][0]["digest"], V["idempotency"][1]["digest"])
        with self.assertRaisesRegex(E2eeError, "idempotency key"):
            e2ee.idempotency_digest(S.sets["integration"].seed, {}, "")


class FileTests(unittest.TestCase):
    def test_reproduces_and_opens_files(self):
        for case in V["files"]:
            with draws(case["random"]):
                sealed = b"".join(e2ee.seal_file(case["key"], pattern(case["size"])))
            self.assertEqual(hashlib.sha256(sealed).hexdigest(), case["sha256"])
            self.assertEqual(len(sealed), e2ee.sealed_size(case["size"]))
            if "sealed" in case:
                self.assertEqual(b64u_encode(sealed), case["sealed"])
            pieces = (sealed[i : i + 1000] for i in range(0, len(sealed), 1000))
            self.assertEqual(b"".join(e2ee.open_file(case["key"], pieces)), pattern(case["size"]))

    def test_rejects_damaged_files(self):
        key = e2ee.file_key()
        sealed = b"".join(e2ee.seal_file(key, [pattern(70000), pattern(65536 + 5)]))
        size = 65536 + 16
        prefix, a, b, c = sealed[:7], sealed[7 : 7 + size], sealed[7 + size : 7 + 2 * size], sealed[7 + 2 * size :]
        self.assertEqual(b"".join(e2ee.open_file(key, sealed)), pattern(70000) + pattern(65541))
        flipped = bytearray(sealed)
        flipped[100] ^= 1
        for name, data in {"tampered": bytes(flipped), "dropped last": prefix + a + b, "dropped middle": prefix + a + c, "reordered": prefix + b + a + c, "trailing byte": sealed + b"\0", "trailing chunk": sealed + c, "cut tag": sealed[:-1], "prefix only": prefix, "empty": b""}.items():
            with self.assertRaisesRegex(E2eeError, "corrupted or truncated", msg=name):
                b"".join(e2ee.open_file(key, data))
        with self.assertRaises(E2eeError):
            b"".join(e2ee.open_file(e2ee.file_key(), sealed))


class BackupAndApprovalTests(unittest.TestCase):
    def test_reproduces_and_opens_keyring_wraps(self):
        keyring = V["keyring"]["value"]
        with draws(V["recovery"]["random"]):
            recovery = e2ee.recovery_key()
        self.assertEqual(recovery.text, V["recovery"]["text"])
        self.assertEqual(e2ee.parse_recovery_key(recovery.text.lower().replace("-", " ").replace("0", "o")), recovery.bytes)
        for bad in [recovery.text[1:], recovery.text + "0", recovery.text[:-1] + "U", recovery.text[:-1] + "Z"]:
            with self.assertRaises(E2eeError, msg=bad):
                e2ee.parse_recovery_key(bad)
        prf, rec = V["backups"]
        with draws(prf["random"]):
            self.assertEqual(e2ee.wrap_keyring(keyring, prf=b64u_decode(prf["secret"]), credential_id=prf["wrapped"]["credentialId"]), prf["wrapped"])
        with draws(rec["random"]):
            self.assertEqual(e2ee.wrap_keyring(keyring, recovery=recovery.bytes), rec["wrapped"])
        self.assertEqual(rec["secret"], b64u_encode(recovery.bytes))
        for case in V["backups"]:
            self.assertEqual(e2ee.unwrap_keyring(case["wrapped"], b64u_decode(case["secret"])), keyring)
            with self.assertRaisesRegex(E2eeError, "Decryption failed"):
                e2ee.unwrap_keyring(case["wrapped"], bytes(32))
        with self.assertRaisesRegex(E2eeError, "Decryption failed"):
            e2ee.unwrap_keyring({**prf["wrapped"], "credentialId": "AQID"}, b64u_decode(prf["secret"]))
        self.assertEqual(len(e2ee.prf_salt()), 32)

    def test_reproduces_and_opens_device_approval(self):
        a = V["approval"]
        transfer = e2ee.transfer_key(a["transfer"]["seed"])
        self.assertEqual((transfer.kid, transfer.box_pub), (a["transfer"]["kid"], a["transfer"]["boxPub"]))
        self.assertEqual(e2ee.device_commit(transfer.box_pub, a["deviceNonce"]), a["commit"])
        self.assertEqual(e2ee.approval_code(transfer.box_pub, a["deviceNonce"], a["approverNonce"]), a["code"])
        with draws(a["random"]):
            self.assertEqual(e2ee.seal_keyring(V["keyring"]["value"], a["device"], transfer.box_pub), a["envelope"])
        self.assertEqual(e2ee.open_keyring(a["envelope"], transfer, a["device"], ACCOUNT), V["keyring"]["value"])
        with self.assertRaisesRegex(E2eeError, "Context mismatch: device"):
            e2ee.open_keyring(a["envelope"], transfer, "other")
        with self.assertRaisesRegex(E2eeError, "No recipient"):
            e2ee.open_keyring(a["envelope"], e2ee.transfer_key(), a["device"])
        other = e2ee.keyring_keys(e2ee.create_keyring(ACCOUNT))
        forged = e2ee.seal(payload=dict(V["keyring"]["value"]), ctx=a["envelope"]["ctx"], signer=other.identity, to=[{"kid": transfer.kid, "box": transfer.box_pub}])
        with self.assertRaisesRegex(E2eeError, "not signed by its identity"):
            e2ee.open_keyring(forged, transfer, a["device"])


W = V["workspace"]


class WorkspaceTests(unittest.TestCase):
    """Team workspace vectors: chain, roster, certificates, wraps, team envelopes and failures."""

    def setUp(self):
        self.ws = e2ee.verify_workspace({"chain": W["chain"], "roster": W["roster"]}, W["fingerprint"])
        self.ids = [e2ee.workspace_identity(s["seed"]) for s in W["identities"]]
        self.people = {n: e2ee.keyring_keys(k) for n, k in W["keyrings"].items()}
        self.ops = [e2ee.team_key_set(W["seeds"][s], self.ws.root) for s in ("ops1", "ops2")]
        self.all = e2ee.team_key_set(W["seeds"]["all1"], self.ws.root)
        self.certs = {}
        for c in W["certificates"]:
            checked = e2ee.verify_workspace_certificate(c["certificate"], self.ws)
            self.certs[checked["kid"]] = checked
        self.openers = {"ops": self.ops[1], "all": self.all, "integration": S.sets["integration"], "destination": S.sets["destination"]}

    def signers(self, env):
        return lambda kid: e2ee.workspace_signer(self.ws, self.certs, env["ctx"], kid)

    def test_reproduces_chain_roster_and_keys(self):
        self.assertEqual(self.ws.pin, W["pin"])
        self.assertEqual(e2ee.safety_code(W["fingerprint"]), W["safetyCode"])
        for got, want in zip(self.ids, W["identities"]):
            self.assertEqual((got.kid, got.box_kid, got.sign_pub, got.box_pub), (want["kid"], want["boxKid"], want["signPub"], want["boxPub"]))
        recovery = e2ee.recovery_key_set(e2ee.parse_recovery_key(W["recovery"]["text"]))
        self.assertEqual((recovery.kid, recovery.box_pub), (W["recovery"]["kid"], W["recovery"]["boxPub"]))
        self.assertEqual(e2ee.recovery_key_text(b64u_decode(W["seeds"]["recovery"])), W["recovery"]["text"])
        self.assertEqual({"ops": [k.kid for k in self.ops], "all": [self.all.kid]}, W["teams"])
        with draws([]):
            link0 = e2ee.workspace_link(workspace=W["workspace"], identity=self.ids[0], recovery=recovery.box_pub)
            link1 = e2ee.workspace_link(workspace=W["workspace"], identity=self.ids[1], recovery=recovery.box_pub, prev=link0, prev_identity=self.ids[0])
            self.assertEqual([link0, link1], W["chain"])
            r = W["roster"]["roster"]
            self.assertEqual(e2ee.sign_roster(epoch=r["epoch"], members=r["members"], teams=r["teams"], head=link1, identity=self.ids[1]), W["roster"])
            ana = self.people["ana"].identity
            for c, signer in zip(W["certificates"], (ana, self.ids[1])):
                body = c["certificate"]["certificate"]
                got = e2ee.certify_workspace(workspace=body["account"], sign=body["sign"], box=body["box"], teams=body["teams"], epoch=body["epoch"], by=body.get("by"), signer=signer)
                self.assertEqual(got, c["certificate"])
        self.assertEqual([[c["teams"], c.get("by")] for c in self.certs.values()], [[["team-ops"], "user-ana"], [["team-all", "team-ops"], None]])

    def test_reproduces_and_opens_wraps_and_envelopes(self):
        ana = self.people["ana"]
        teamkey, wskey = W["wraps"]
        with draws(teamkey["random"]):
            env = e2ee.wrap_team_key(ws=self.ws, seed=W["seeds"]["ops2"], signer=self.ids[1], **teamkey["ctx"])
        self.assertEqual(env, teamkey["envelope"])
        with draws(wskey["random"]):
            env = e2ee.wrap_workspace_key(ws=self.ws, seed=W["seeds"]["identity1"], signer=self.ids[1], **wskey["ctx"])
        self.assertEqual(env, wskey["envelope"])
        recovery = e2ee.recovery_key_set(b64u_decode(W["seeds"]["recovery"]))
        for opener in (ana.inbox, [recovery]):
            self.assertEqual(e2ee.open_team_key(teamkey["envelope"], ws=self.ws, recipients=opener, **teamkey["ctx"]).kid, self.ops[1].kid)
        self.assertEqual(e2ee.open_workspace_key(wskey["envelope"], ws=self.ws, recipients=ana.inbox, **wskey["ctx"]).sign_pub, self.ws.head["identity"])
        signer_keys = {"integration": S.sets["integration"], **{n: p.identity for n, p in self.people.items()}}
        for case in W["envelopes"]:
            with draws(case["random"]):
                env = e2ee.seal(payload=case["payload"], ctx=case["ctx"], signer=signer_keys[case["signer"]], to=[{"kid": self.openers[n].kid, "box": self.openers[n].box_pub} for n in case["to"]])
            self.assertEqual(env, case["envelope"], case["name"])
            for name in case["to"]:
                got = e2ee.open(env, recipients=[self.openers[name]], signers=self.signers(env), expect=env["ctx"])
                self.assertEqual(got, {"v": 1, **case["payload"]})

    def test_rejects_every_workspace_negative_case(self):
        ana = self.people["ana"]
        for c in W["negative"]:
            with self.assertRaisesRegex(E2eeError, re.escape(c["error"]), msg=c["name"]):
                if c["kind"] == "envelope":
                    e2ee.open(c["envelope"], recipients=[self.ops[1]], signers=self.signers(c["envelope"]), expect=c["envelope"]["ctx"])
                elif c["kind"] == "workspace":
                    e2ee.verify_workspace({"chain": c["chain"], "roster": c["roster"]}, W["fingerprint"], pin=c.get("pin"))
                elif c["kind"] == "certificate":
                    e2ee.verify_workspace_certificate(c["certificate"], self.ws)
                elif c["kind"] == "teamkey":
                    e2ee.open_team_key(c["envelope"], ws=self.ws, recipients=ana.inbox, **c["ctx"])
                elif c["kind"] == "wskey":
                    e2ee.open_workspace_key(c["envelope"], ws=self.ws, recipients=ana.inbox, **c["ctx"])
                elif c["kind"] == "join":
                    e2ee.verify_join_proof(b64u_decode(c["secret"]), c["proof"], **c["claim"])
                elif c["kind"] == "receiver":
                    member = e2ee.team_member(self.ws, c["claim"]["member"], c["team"])
                    claim = c["claim"]
                    e2ee.verify_receiver(c["sig"], member["identity"], message=claim["message"], claim_id=claim["claimId"], public_key=claim["publicKey"], member=claim["member"])
                else:
                    e2ee._check_ctx(c["ctx"])

    def test_join_proof_and_member_receiver(self):
        j = W["join"]
        secret = e2ee.invite_secret(W["seeds"]["identity1"], j["claim"]["invite"])
        self.assertEqual(b64u_encode(secret), j["secret"])
        self.assertEqual(e2ee.join_proof(secret, **j["claim"]), j["proof"])
        e2ee.verify_join_proof(secret, j["proof"], **j["claim"])
        self.assertEqual(e2ee.invite_fragment(secret, W["fingerprint"]), j["fragment"])
        self.assertEqual(e2ee.parse_invite_fragment("#" + j["fragment"]), (secret, W["fingerprint"]))
        with self.assertRaisesRegex(E2eeError, "Malformed invite link"):
            e2ee.parse_invite_fragment(j["secret"])
        self.assertEqual([m["name"] for m in self.ws.members.values()], ["Ana", "Ben"])
        with self.assertRaisesRegex(E2eeError, "Bad join proof"):
            e2ee.verify_join_proof(secret, j["proof"], **{**j["claim"], "user": "user-eve"})
        r = W["receiver"]
        claim = r["claim"]
        self.assertEqual(e2ee.sign_receiver(W["keyrings"]["ana"], message=claim["message"], claim_id=claim["claimId"], public_key=claim["publicKey"], member=claim["member"]), r["sig"])


class WorkspaceClientTests(unittest.IsolatedAsyncioTestCase):
    """A keyed client in a team workspace: team sealing, stale-key reseal, verified `answered_by`, fail-closed pins."""

    def setUp(self):
        integration = next(s for s in V["keySets"] if s["name"] == "integration")
        self.token, self.kid = e2ee.format_token("hdr_ws-test", integration["seed"], W["fingerprint"]), integration["kid"]
        self.directory = {"account": None, "certificates": [{**c["certificate"], "integrationId": c["name"]} for c in W["certificates"]], "workspace": {"chain": W["chain"], "roster": W["roster"]}}
        sent = next(s for s in json.loads((Path(__file__).parents[2] / "sdk/fixtures/contracts.json").read_text())["e2ee"]["steps"] if s["name"] == "send")["response"]["body"]
        self.record = {**sent, "id": W["envelopes"][0]["ctx"]["id"], "team": "team-ops", "senderId": "integration", "sealed": W["envelopes"][0]["envelope"]}

    def client(self, routes, directory=None, **kwargs):
        import httpx
        from herald import Herald
        seen = []

        def serve(request):
            seen.append(request)
            if request.url.path == "/api/v1/keys":
                return httpx.Response(200, json=directory or self.directory)
            out = routes(request)
            return out if isinstance(out, httpx.Response) else httpx.Response(200, json=out)
        return Herald(api_key=self.token, url="https://herald.test", transport=httpx.MockTransport(serve), **kwargs), seen

    async def test_seals_to_the_team_and_reseals_once_when_stale(self):
        import httpx
        from herald import __version__
        posts, pins = [], []

        def routes(request):
            posts.append(json.loads(request.content))
            return httpx.Response(409, json={"error": "Stale.", "code": "E2EE_STALE_KEY"}) if len(posts) == 1 else self.record
        herald, seen = self.client(routes, workspace=W["workspace"], on_pin=pins.append)
        await herald.send(title="Restart?")
        body = posts[1]
        self.assertEqual((body["team"], body["sealed"]["ctx"]["team"]), ("team-ops", "team-ops"))
        self.assertEqual([t["kid"] for t in body["sealed"]["to"]], [W["teams"]["ops"][1], self.kid])
        self.assertNotEqual(posts[0]["id"], posts[1]["id"])
        self.assertEqual([r.url.path for r in seen].count("/api/v1/keys"), 2)
        self.assertEqual((seen[1].headers["X-Herald-Client"], seen[1].headers["Herald-Workspace"]), ("sdk/" + __version__, W["workspace"]))
        self.assertEqual(pins, [W["pin"]])
        self.assertEqual([t["slug"] for t in (await herald.workspace())["teams"]], ["ops"])
        with self.assertRaisesRegex(E2eeError, "may not address team all"):
            await herald.send(title="x", team="all")

    async def test_answered_by_only_when_verified(self):
        response = {"values": {}, "secretFields": [], "createdAt": self.record["createdAt"], "sealed": W["envelopes"][1]["envelope"], "by": "user-ben"}
        answered = {**self.record, "status": "answered", "kind": "form", "answeredBy": "user-ben", "response": response}
        forged = next(c for c in W["negative"] if c["name"] == "member outside the team")["envelope"]
        for record, by in ((answered, "user-ana"), ({**answered, "response": {**response, "sealed": forged}}, None), ({**answered, "team": "team-all"}, None)):
            herald, _ = self.client(lambda request, r=record: r)
            got = await herald.get(record["id"])
            self.assertEqual((got.answered_by, got.response.by, got.unverified), (by, by, None if by else True))

    async def test_fails_closed_on_rollback_and_missing_workspace(self):
        for pin, directory in (({**W["pin"], "epoch": 3}, None), (W["pin"], {**self.directory, "workspace": None})):
            herald, _ = self.client(lambda request: self.record, directory, pin=pin)
            with self.assertRaises(E2eeError):
                await herald.send(title="x")

    async def test_record_team_only_from_a_verified_envelope_or_own_send(self):
        from herald.keyed import KeyedSession
        integration = next(s for s in V["keySets"] if s["name"] == "integration")

        async def directory():
            return self.directory

        def keyed():
            return KeyedSession(integration["seed"], W["fingerprint"], directory)
        k = keyed()
        body = await k.seal_message({"title": "x"}, "key-1")
        self.assertEqual(await k.team_of(body["id"]), "team-ops")
        for bad in ({**self.record, "team": "team-all"}, {**self.record, "sealed": W["envelopes"][1]["envelope"]}):
            s = keyed()
            self.assertTrue((await s.open_record(bad))["unverified"])
            with self.assertRaisesRegex(E2eeError, "The record has no team"):
                await s.team_of(bad["id"])
        claim, sig = W["receiver"]["claim"], W["receiver"]["sig"]
        receiver = {"claimId": claim["claimId"], "publicKey": claim["publicKey"], "sig": sig, "member": claim["member"]}

        async def record():
            return self.record
        r = keyed()
        self.assertEqual(await r.check_receiver(claim["message"], receiver, record), receiver)
        with self.assertRaisesRegex(E2eeError, "Not a member of the team"):
            await r.check_receiver(claim["message"], {**receiver, "member": "user-ben"}, record)

    async def test_reads_herald_pin_and_fails_closed(self):
        from unittest import mock
        with mock.patch.dict("os.environ", {"HERALD_PIN": json.dumps({**W["pin"], "epoch": 3})}):
            herald, _ = self.client(lambda request: self.record)
            with self.assertRaisesRegex(E2eeError, "Stale roster epoch"):
                await herald.send(title="x")
        with mock.patch.dict("os.environ", {"HERALD_PIN": '{"workspace": "ws_x"}'}):
            with self.assertRaisesRegex(E2eeError, "Malformed workspace pin"):
                self.client(lambda request: self.record)


class WorkspaceAnchorTests(unittest.TestCase):
    """Keyring anchors and explicit re-certification."""

    def test_keyring_pin_never_swaps_root_or_downgrades(self):
        keyring = e2ee.create_keyring("user-ana")
        anchor = {"workspace": W["workspace"], "fingerprint": W["fingerprint"], "pin": W["pin"]}
        pinned = e2ee.keyring_pin(keyring, **anchor)
        self.assertEqual(pinned["workspaces"], [anchor])
        self.assertEqual(e2ee.parse_workspace_pin(json.dumps(W["pin"])), W["pin"])
        newer = {**W["pin"], "epoch": 3, "roster": W["pin"]["link"]}
        updated = e2ee.keyring_pin(pinned, **{**anchor, "pin": newer})
        self.assertEqual(updated["workspaces"], [{**anchor, "pin": newer}])
        self.assertEqual(e2ee.keyring_pin(pinned, workspace=W["workspace"], fingerprint=W["fingerprint"])["workspaces"], [anchor])
        with self.assertRaisesRegex(E2eeError, "Stale roster epoch"):
            e2ee.keyring_pin(updated, **anchor)
        with self.assertRaisesRegex(E2eeError, "Workspace fingerprint mismatch"):
            e2ee.keyring_pin(pinned, **{**anchor, "fingerprint": e2ee.fingerprint(W["identities"][1]["signPub"])})

    def test_recertifies_with_previous_teams_only(self):
        previous = e2ee.verify_workspace({"chain": W["chain"], "roster": W["roster"]}, W["fingerprint"])
        head = e2ee.workspace_identity(W["identities"][1]["seed"])
        r = W["roster"]["roster"]
        ana = {**r["members"][0], "teams": ["team-all"]}
        nxt = e2ee.sign_roster(epoch=3, members=[ana], teams=r["teams"], head=W["chain"][1], identity=head)
        current = e2ee.verify_workspace({"chain": W["chain"], "roster": nxt}, W["fingerprint"])
        cert = W["certificates"][0]["certificate"]
        again = e2ee.recertify_workspace(cert, previous=previous, current=current, identity=head)
        self.assertEqual((again["certificate"]["teams"], again["certificate"]["epoch"], "by" in again["certificate"]), (["team-ops"], 3, False))
        self.assertEqual(e2ee.verify_workspace_certificate(again, current)["teams"], ["team-ops"])
        failing = next(c for c in W["negative"] if c["name"] == "member without connect")["certificate"]
        with self.assertRaisesRegex(E2eeError, "may not connect"):
            e2ee.recertify_workspace(failing, previous=previous, current=current, identity=head)
        with self.assertRaisesRegex(E2eeError, "re-signed by the head"):
            e2ee.recertify_workspace(cert, previous=previous, current=current, identity=e2ee.workspace_identity(W["identities"][0]["seed"]))
        with self.assertRaisesRegex(E2eeError, "Not the previous roster"):
            e2ee.recertify_workspace(cert, previous=current, current=current, identity=head)


if __name__ == "__main__":
    unittest.main()
