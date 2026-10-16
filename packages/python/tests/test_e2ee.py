"""Python side of the shared end-to-end vectors (packages/sdk/fixtures/e2ee-vectors.json): reproduce every output, open every input."""
import hashlib
import json
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


if __name__ == "__main__":
    unittest.main()
