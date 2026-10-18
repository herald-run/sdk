"""End-to-end encryption, compatible with `@herald-run/sdk/e2ee`: key sets, signed envelopes, sealed files and keyring backups."""
import base64
import hashlib
import hmac
import json
import math
import os
import re
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from decimal import Decimal
from typing import Callable, Iterable, Iterator, NamedTuple, Optional, Union

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

BytesLike = Union[bytes, bytearray, memoryview]


class E2eeError(ValueError):
    """A key, signature, context or ciphertext failed a check."""


def _fail(message):
    raise E2eeError(message)


def _random(length):
    return os.urandom(length)


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# Encoding


_B64U = re.compile(r"[A-Za-z0-9_-]*")


def b64u_encode(data: BytesLike) -> str:
    return base64.urlsafe_b64encode(bytes(data)).rstrip(b"=").decode()


def b64u_decode(text: str) -> bytes:
    """Strict base64url without padding."""
    if not isinstance(text, str) or not _B64U.fullmatch(text) or len(text) % 4 == 1:
        _fail("Invalid base64url.")
    out = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    if b64u_encode(out) != text:
        _fail("Invalid base64url.")
    return out


def _bytes(value, length=None) -> bytes:
    if not isinstance(value, (str, bytes, bytearray, memoryview)):
        _fail("Expected bytes.")
    out = b64u_decode(value) if isinstance(value, str) else bytes(value)
    if length is not None and len(out) != length:
        _fail(f"Expected {length} bytes.")
    return out


_MAX_INT = 2**53 - 1
_SURROGATE = re.compile("[\ud800-\udfff]")


def _string(text):
    return _SURROGATE.sub(lambda m: "\\u%04x" % ord(m.group()), json.dumps(text, ensure_ascii=False))


def _number(value):
    if isinstance(value, float):
        if not math.isfinite(value):
            _fail("canon: number out of range.")
        if not value.is_integer():
            return _js_float(value)
        value = int(value)
    if abs(value) > _MAX_INT:
        _fail("canon: number out of range.")
    return str(value)


def _js_float(value):
    """A non-integer float as JavaScript's Number#toString writes it."""
    _, digits, exponent = Decimal(repr(abs(value))).as_tuple()
    d = "".join(map(str, digits))
    n = exponent + len(d)
    if 0 < n <= 21:
        text = d[:n] + "." + d[n:]
    elif -6 < n <= 0:
        text = "0." + "0" * -n + d
    else:
        text = d[0] + ("." + d[1:] if len(d) > 1 else "") + "e" + ("+" if n > 1 else "-") + str(abs(n - 1))
    return ("-" if value < 0 else "") + text


def _dump(value, sort):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_dump(item, sort) for item in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            _fail("canon: keys must be strings.")
        items = list(value.items())
        if sort:
            items.sort(key=lambda item: item[0].encode("utf-16-be", "surrogatepass"))
        return "{" + ",".join(_string(key) + ":" + _dump(item, sort) for key, item in items) + "}"
    return _fail(f"canon: unsupported {type(value).__name__}.")


def canon(value) -> str:
    """Canonical JSON: keys sorted by UTF-16 code unit, no whitespace, numbers and strings as JSON.stringify writes them."""
    return _dump(value, True)


# Hashing


def _sha256(*parts):
    return hashlib.sha256(b"".join(parts)).digest()


def _hmac(key, *data):
    return hmac.new(key, b"".join(data), hashlib.sha256).digest()


def _expand(prk, info, length):
    out, block, i = b"", b"", 1
    while len(out) < length:
        block = _hmac(prk, block, info, bytes([i]))
        out, i = out + block, i + 1
    return out[:length]


def _hkdf(ikm, info, length=32):
    return _expand(_hmac(b"", ikm), info.encode(), length)


def H(label: str, *parts) -> bytes:
    """`SHA-256("herald/e2ee/v1 " + label || 0x00 || parts...)`; strings are UTF-8."""
    return _sha256(("herald/e2ee/v1 " + label).encode(), b"\0", *(p.encode() if isinstance(p, str) else bytes(p) for p in parts))


def _aes_decrypt(key, iv, aad, data, message="Decryption failed."):
    try:
        return AESGCM(key).decrypt(iv, data, aad)
    except InvalidTag:
        return _fail(message)


# Keys


def _raw_pub(key):
    return key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def _dh(priv, pub):
    try:
        return priv.exchange(X25519PublicKey.from_public_bytes(_bytes(pub, 32)))
    except ValueError:
        return _fail("Invalid X25519 public key.")


def _verify(pub, sig, message):
    try:
        Ed25519PublicKey.from_public_bytes(_bytes(pub, 32)).verify(_bytes(sig, 64), message)
        return True
    except (InvalidSignature, ValueError):
        return False


def _kid(*parts):
    return b64u_encode(H("kid", *parts)[:16])


def fingerprint(identity_sign_pub) -> str:
    """The account fingerprint: `b64u(H("fp", identitySignPub)[0:16])`; tokens pin it."""
    return b64u_encode(H("fp", _bytes(identity_sign_pub, 32))[:16])


def safety_code(fp: str) -> str:
    """The safety code people compare: the fingerprint as a big-endian integer mod 10^30, in 6 groups of 5 digits."""
    digits = str(int.from_bytes(_bytes(fp, 16), "big") % 10**30).zfill(30)
    return " ".join(digits[i : i + 5] for i in range(0, 30, 5))


@dataclass(frozen=True)
class KeySet:
    """Public parts are base64url strings; `sign_priv` and `box_priv` are `cryptography` keys."""

    seed: str
    kid: str
    sign_pub: str
    box_pub: str
    sign_priv: Ed25519PrivateKey
    box_priv: X25519PrivateKey


def key_set(seed=None) -> KeySet:
    """An Ed25519 signing key and an X25519 box key derived from one 32-byte seed."""
    raw = _random(32) if seed is None else _bytes(seed, 32)
    sign = Ed25519PrivateKey.from_private_bytes(_hkdf(raw, "herald/e2ee/v1 sign"))
    box = X25519PrivateKey.from_private_bytes(_hkdf(raw, "herald/e2ee/v1 box"))
    sign_pub, box_pub = _raw_pub(sign), _raw_pub(box)
    return KeySet(b64u_encode(raw), _kid(sign_pub, box_pub), b64u_encode(sign_pub), b64u_encode(box_pub), sign, box)


# HPKE (RFC 9180) base mode, single shot: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-GCM.
# AEAD 2 (AES-256-GCM) is the protocol suite; 1 exists for the RFC test vectors.
_KEM = b"KEM\x00\x20"


def _suite(aead):
    return b"HPKE\x00\x20\x00\x01\x00" + bytes([aead])


def _labeled_extract(suite, salt, label, ikm):
    return _hmac(salt, b"HPKE-v1" + suite + label.encode() + ikm)


def _labeled_expand(suite, prk, label, info, length):
    return _expand(prk, length.to_bytes(2, "big") + b"HPKE-v1" + suite + label.encode() + info, length)


def _derive_key_pair(ikm):
    prk = _labeled_extract(_KEM, b"", "dkp_prk", ikm)
    key = X25519PrivateKey.from_private_bytes(_labeled_expand(_KEM, prk, "sk", b"", 32))
    return key, _raw_pub(key)


def _hpke_context(dh, enc, pk_r, info, aead):
    shared = _labeled_expand(_KEM, _labeled_extract(_KEM, b"", "eae_prk", dh), "shared_secret", enc + pk_r, 32)
    suite = _suite(aead)
    context = b"\0" + _labeled_extract(suite, b"", "psk_id_hash", b"") + _labeled_extract(suite, b"", "info_hash", info)
    secret = _labeled_extract(suite, shared, "secret", b"")
    return _labeled_expand(suite, secret, "key", context, 16 if aead == 1 else 32), _labeled_expand(suite, secret, "base_nonce", context, 12)


def _hpke_seal(pk_r, info, aad, pt, aead=2):
    sk_e, enc = _derive_key_pair(_random(32))
    key, nonce = _hpke_context(_dh(sk_e, pk_r), enc, pk_r, info, aead)
    return enc, AESGCM(key).encrypt(nonce, pt, aad)


def _hpke_open(sk_r, pk_r, enc, info, aad, ct, aead=2):
    key, nonce = _hpke_context(_dh(sk_r, enc), enc, pk_r, info, aead)
    return _aes_decrypt(key, nonce, aad, ct)


# Envelopes

_CTX = {
    "message": {"id": "uuid"},
    "response": {"message": str, "request": str},
    "task": {"id": "uuid", "destination": str, "type": str},
    "log": {"task": str, "seq": int},
    "result": {"task": str},
    "secret": {"message": str, "field": str},
    "keyring": {"device": str},
    "teamkey": {},
    "wskey": {},
}
# Fields a `ws_` (team workspace) account's contexts add; forbidden elsewhere.
_WORKSPACE = {
    "message": {"team": str},
    "log": {"team": str},
    "result": {"team": str},
    "response": {"team": str, "member": str},
    "task": {"team": str, "member": str},
    "secret": {"team": str, "member": str},
    "teamkey": {"team": str, "kv": int, "member": str},
    "wskey": {"n": int, "member": str},
}


def is_workspace(account) -> bool:
    """Team workspace ids start with `ws_`; personal account ids never do."""
    return isinstance(account, str) and account.startswith("ws_")
_KEY_INFO = b"herald/e2ee/v1 key"
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
# Largest payload JSON, in UTF-8 bytes, whose ciphertext fits the envelope schema.
MAX_PAYLOAD_BYTES = 134984


def _check_ctx(ctx, expect=None):
    if not isinstance(ctx, dict) or ctx.get("t") not in _CTX:
        _fail("Unknown context type.")
    ws = is_workspace(ctx.get("account"))
    if not ws and not _CTX[ctx["t"]]:
        _fail("Unknown context type.")
    want = {"t": str, "account": str, **_CTX[ctx["t"]], **(_WORKSPACE.get(ctx["t"], {}) if ws else {})}
    for key in ctx:
        if key not in want:
            _fail(f"Unexpected ctx.{key}.")
    for key, kind in want.items():
        value = ctx.get(key)
        if kind is int:
            ok = isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= _MAX_INT
        elif kind == "uuid":
            # The record's UUID, chosen by the sender, so the server cannot replay content elsewhere.
            ok = isinstance(value, str) and _UUID.fullmatch(value) is not None
        else:
            ok = isinstance(value, str) and value != ""
        if not ok:
            _fail(f"Invalid ctx.{key}.")
    if expect is None:
        return
    if not isinstance(expect.get("t"), str) or not isinstance(expect.get("account"), str):
        _fail("Expected ctx needs t and account.")
    for key, value in expect.items():
        if type(ctx.get(key)) is not type(value) or ctx.get(key) != value:
            _fail(f"Context mismatch: {key}.")


def _with_version(payload):
    if not isinstance(payload, dict):
        _fail("Payload must be an object.")
    if "v" in payload and payload["v"] != 1:
        _fail("Unsupported payload version.")
    return payload if "v" in payload else {"v": 1, **payload}


def _head(env):
    return H("head", canon({"v": env["v"], "ctx": env["ctx"], "from": env["from"]}))


def _sig_input(head, env):
    return H("sig", head, _sha256(b64u_decode(env["iv"]), b64u_decode(env["ct"])))


def _check_envelope(env):
    if not isinstance(env, dict) or env.get("v") != 1 or isinstance(env.get("v"), bool):
        _fail("Unsupported envelope version.")
    if not isinstance(env.get("from"), str) or not isinstance(env.get("to"), list) or not env["to"]:
        _fail("Malformed envelope.")
    _bytes(env.get("iv"), 12)
    _bytes(env.get("sig"), 64)
    if len(b64u_decode(env.get("ct"))) < 16:
        _fail("Malformed envelope.")
    return _head(env)


def _verify_sig(env, head, sign_pub):
    if not _verify(sign_pub, env["sig"], _sig_input(head, env)):
        _fail("Bad signature.")


def _unwrap_key(env, head, recipients):
    for entry in env["to"]:
        me = next((r for r in recipients if r.kid == entry["kid"]), None)
        if me is None:
            continue
        aad = H("key", head, entry["kid"])
        cek = _hpke_open(me.box_priv, _bytes(me.box_pub, 32), _bytes(entry["enc"], 32), _KEY_INFO, aad, b64u_decode(entry["key"]))
        return cek if len(cek) == 32 else _fail("Malformed content key.")
    return _fail("No recipient entry for these keys.")


def _decrypt_payload(env, head, cek):
    plain = _aes_decrypt(cek, b64u_decode(env["iv"]), H("content", head), b64u_decode(env["ct"]))
    payload = json.loads(plain.decode("utf-8"))
    if not isinstance(payload, dict) or payload.get("v") != 1:
        _fail("Unsupported payload version.")
    return payload


def _wrap_key(head, cek, to):
    enc, key = _hpke_seal(_bytes(to["box"], 32), _KEY_INFO, H("key", head, to["kid"]), cek)
    return {"kid": to["kid"], "enc": b64u_encode(enc), "key": b64u_encode(key)}


def seal(*, payload: dict, ctx: dict, signer, to: list) -> dict:
    """Encrypts and signs `payload` from `signer` (`.kid`, `.sign_priv`) to `{kid, box}` recipients. `message` and `task` contexts carry the record's `id`."""
    if not 1 <= len(to) <= 16:
        _fail("Seal to 1 to 16 recipients.")
    _check_ctx(ctx)
    payload = _with_version(payload)
    plain = _dump(payload, False).encode()
    if len(plain) > MAX_PAYLOAD_BYTES:
        _fail(f"Content is too large to encrypt: {len(plain)} bytes, at most {MAX_PAYLOAD_BYTES}.")
    env = {"v": 1, "ctx": ctx, "from": signer.kid}
    head = _head(env)
    cek, iv = _random(32), _random(12)
    ct = AESGCM(cek).encrypt(iv, plain, H("content", head))
    env.update(to=[_wrap_key(head, cek, r) for r in to], iv=b64u_encode(iv), ct=b64u_encode(ct))
    env["sig"] = b64u_encode(signer.sign_priv.sign(_sig_input(head, env)))
    return env


def open(env: dict, *, recipients: list, signers: Callable[[str], Optional[str]], expect: dict) -> dict:
    """Verifies the signature against a trusted signer, checks the context, then decrypts. `signers` maps a kid to its trusted Ed25519 public key."""
    head = _check_envelope(env)
    sign_pub = signers(env["from"])
    if sign_pub is None:
        _fail("Untrusted signer.")
    _verify_sig(env, head, sign_pub)
    _check_ctx(env["ctx"], expect)
    return _decrypt_payload(env, head, _unwrap_key(env, head, recipients))


def open_key(env: dict, recipients: list) -> bytes:
    """Recovers the content key without verifying; open the envelope first."""
    return _unwrap_key(env, _check_envelope(env), recipients)


def grant(env: dict, cek: BytesLike, to: dict) -> dict:
    """A recipient entry giving another key access to an existing envelope."""
    return _wrap_key(_check_envelope(env), _bytes(cek, 32), to)


def envelope_digest(env: dict) -> str:
    """`b64u(SHA-256(iv || ct))`; binds a response to its request."""
    return b64u_encode(_sha256(b64u_decode(env["iv"]), b64u_decode(env["ct"])))


def idempotency_digest(seed, payload: dict, idempotency_key: str) -> str:
    """A retry-stable digest of a payload and its idempotency key, keyed by the integration seed; equal content under different keys stays unlinkable."""
    if not isinstance(idempotency_key, str) or not idempotency_key:
        _fail("Missing idempotency key.")
    data = canon({"key": idempotency_key, "payload": _with_version(payload)})
    return b64u_encode(_hmac(_hkdf(_bytes(seed, 32), "herald/e2ee/v1 idem"), data.encode()))


# Files: 7-byte random prefix, then AES-256-GCM chunks of up to 64 KiB plaintext.
# Chunk i uses nonce prefix || uint32_be(i) || last and AAD H("file").
_CHUNK, _TAG, _PREFIX = 65536, 16, 7
_CORRUPT = "File is corrupted or truncated."


def file_key() -> str:
    return b64u_encode(_random(32))


def sealed_size(size: int) -> int:
    return _PREFIX + size + _TAG * max(1, -(-size // _CHUNK))


def _pieces(source):
    if isinstance(source, (bytes, bytearray, memoryview)):
        yield bytes(source)
    else:
        for piece in source:
            yield bytes(piece)


def _nonce(prefix, index, last):
    if index > 0xFFFFFFFF:
        _fail("File too large.")
    return prefix + index.to_bytes(4, "big") + (b"\1" if last else b"\0")


def seal_file(key, source: Union[BytesLike, Iterable[BytesLike]]) -> Iterator[bytes]:
    """Yields the sealed file in pieces."""
    aes, aad, prefix = AESGCM(_bytes(key, 32)), H("file"), _random(_PREFIX)
    yield prefix
    buffer, index = b"", 0
    for piece in _pieces(source):
        buffer += piece
        while len(buffer) > _CHUNK:
            yield aes.encrypt(_nonce(prefix, index, False), buffer[:_CHUNK], aad)
            buffer, index = buffer[_CHUNK:], index + 1
    yield aes.encrypt(_nonce(prefix, index, True), buffer, aad)


def open_file(key, source: Union[BytesLike, Iterable[BytesLike]]) -> Iterator[bytes]:
    """Yields the plaintext; raises on tampering, truncation, reordering or trailing data."""
    key, aad, size = _bytes(key, 32), H("file"), _CHUNK + _TAG
    buffer, prefix, index = b"", None, 0
    for piece in _pieces(source):
        buffer += piece
        if prefix is None and len(buffer) >= _PREFIX:
            prefix, buffer = buffer[:_PREFIX], buffer[_PREFIX:]
        while prefix is not None and len(buffer) > size:
            yield _aes_decrypt(key, _nonce(prefix, index, False), aad, buffer[:size], _CORRUPT)
            buffer, index = buffer[size:], index + 1
    if prefix is None or len(buffer) < _TAG:
        _fail(_CORRUPT)
    yield _aes_decrypt(key, _nonce(prefix, index, True), aad, buffer, _CORRUPT)


# Keyring: {v: 1, account, identity: seed, inbox: [{seed, created}]}, newest inbox last.


@dataclass(frozen=True)
class KeyringKeys:
    """Key sets carry their account kids: the identity's signer kid and each inbox's recipient kid."""

    identity: KeySet
    inbox: list
    signer_kid: str
    inbox_kid: str


@dataclass(frozen=True)
class AccountInfo:
    identity: str
    inbox: str
    signer_kid: str
    inbox_kid: str


def _check_keyring(keyring):
    ok = (
        isinstance(keyring, dict)
        and keyring.get("v") == 1
        and isinstance(keyring.get("account"), str)
        and keyring["account"] != ""
        and isinstance(keyring.get("inbox"), list)
        and len(keyring["inbox"]) > 0
        and all(isinstance(entry, dict) and isinstance(entry.get("created"), str) for entry in keyring["inbox"])
        and isinstance(keyring.get("workspaces", []), list)
    )
    if not ok:
        _fail("Malformed keyring.")
    _bytes(keyring["identity"], 32)
    for entry in keyring["inbox"]:
        _bytes(entry["seed"], 32)
    return keyring


def create_keyring(account: str) -> dict:
    identity = b64u_encode(_random(32))
    return {"v": 1, "account": account, "identity": identity, "inbox": [{"seed": b64u_encode(_random(32)), "created": _now()}]}


def keyring_keys(keyring: dict) -> KeyringKeys:
    _check_keyring(keyring)
    own = key_set(keyring["identity"])
    id_pub = b64u_decode(own.sign_pub)
    identity = replace(own, kid=_kid(id_pub))
    inbox = [replace(s, kid=_kid(id_pub, b64u_decode(s.box_pub))) for s in (key_set(e["seed"]) for e in keyring["inbox"])]
    return KeyringKeys(identity, inbox, identity.kid, inbox[-1].kid)


def account_statement(keyring: dict) -> dict:
    """The signed statement the server publishes: identity key and newest inbox key."""
    keys = keyring_keys(keyring)
    statement = {"v": 1, "account": keyring["account"], "identity": keys.identity.sign_pub, "inbox": keys.inbox[-1].box_pub, "created": keyring["inbox"][-1]["created"]}
    return {"statement": statement, "sig": b64u_encode(keys.identity.sign_priv.sign(H("account", canon(statement))))}


def verify_account(keys: dict, pinned_fp: str, account: Optional[str] = None) -> AccountInfo:
    """Accepts a published statement only under the pinned fingerprint (and account, when given)."""
    statement = keys.get("statement") or {}
    if statement.get("v") != 1:
        _fail("Unsupported statement version.")
    if fingerprint(statement["identity"]) != pinned_fp:
        _fail("Account fingerprint mismatch.")
    if account is not None and statement["account"] != account:
        _fail("Account mismatch.")
    if not _verify(statement["identity"], keys["sig"], H("account", canon(statement))):
        _fail("Bad statement signature.")
    identity = _bytes(statement["identity"], 32)
    return AccountInfo(statement["identity"], statement["inbox"], _kid(identity), _kid(identity, _bytes(statement["inbox"], 32)))


def certify(keyring: dict, *, sign: str, box: str) -> dict:
    """The owner's approval of an integration key set."""
    identity = keyring_keys(keyring).identity
    body = {"v": 1, "account": keyring["account"], "kid": _kid(_bytes(sign, 32), _bytes(box, 32)), "sign": sign, "box": box, "created": _now()}
    return {"certificate": body, "sig": b64u_encode(identity.sign_priv.sign(H("cert", canon(body))))}


def verify_certificate(cert: dict, identity_sign_pub: str, account: str) -> dict:
    body = cert.get("certificate") or {}
    if body.get("v") != 1:
        _fail("Unsupported certificate version.")
    if body["account"] != account:
        _fail("Certificate account mismatch.")
    if body["kid"] != _kid(_bytes(body["sign"], 32), _bytes(body["box"], 32)):
        _fail("Certificate kid mismatch.")
    if not _verify(identity_sign_pub, cert["sig"], H("cert", canon(body))):
        _fail("Bad certificate signature.")
    return {"kid": body["kid"], "sign": body["sign"], "box": body["box"]}


def _receiver_input(message, claim_id, public_key, member):
    claim = {"message": message, "claimId": claim_id, "publicKey": public_key, **({} if member is None else {"member": member})}
    return H("receiver", canon(claim))


def sign_receiver(keyring: dict, *, message: str, claim_id: str, public_key, member: Optional[str] = None) -> str:
    """Signs a secret receiver's one-time public key with the account identity; in a team workspace, the claiming `member`'s personal identity."""
    identity = keyring_keys(keyring).identity
    return b64u_encode(identity.sign_priv.sign(_receiver_input(message, claim_id, public_key, member)))


def verify_receiver(sig: str, identity_sign_pub: str, *, message: str, claim_id: str, public_key, member: Optional[str] = None) -> None:
    if not _verify(identity_sign_pub, sig, _receiver_input(message, claim_id, public_key, member)):
        _fail("Bad receiver signature.")


# Backups. Recovery keys: 32 bytes as Crockford base32 (most significant bit first), groups of four.
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


class RecoveryKey(NamedTuple):
    bytes: bytes
    text: str


def prf_salt() -> bytes:
    """The WebAuthn PRF input (`eval.first`) for passkey backups."""
    return H("prf-salt")


def recovery_key_text(raw: BytesLike) -> str:
    """The text form of recovery key bytes."""
    bits = "".join(f"{n:08b}" for n in _bytes(raw, 32)) + "0000"
    text = "".join(_CROCKFORD[int(bits[i : i + 5], 2)] for i in range(0, 260, 5))
    return "-".join(text[i : i + 4] for i in range(0, 52, 4))


def recovery_key() -> RecoveryKey:
    raw = _random(32)
    return RecoveryKey(raw, recovery_key_text(raw))


def parse_recovery_key(text: str) -> bytes:
    """Reads a recovery key, ignoring case, spaces and dashes, with O as 0 and I or L as 1."""
    clean = re.sub(r"[\s-]", "", text.upper()).replace("O", "0").replace("I", "1").replace("L", "1")
    if len(clean) != 52 or any(c not in _CROCKFORD for c in clean):
        _fail("Invalid recovery key.")
    bits = "".join(f"{_CROCKFORD.index(c):05b}" for c in clean)
    if bits[256:] != "0000":
        _fail("Invalid recovery key.")
    return int(bits[:256], 2).to_bytes(32, "big")


def _wrapping(kind, secret, credential_id=None):
    if kind == "prf":
        if credential_id is None:
            _fail("Missing credentialId.")
        return _hkdf(bytes(secret), "herald/e2ee/v1 prf-wrap"), H("wrap", "prf", b64u_decode(credential_id))
    return _hkdf(_bytes(secret, 32), "herald/e2ee/v1 recovery-wrap"), H("wrap", "recovery")


def wrap_keyring(keyring: dict, *, prf: Optional[BytesLike] = None, credential_id: Optional[str] = None, recovery: Optional[BytesLike] = None) -> dict:
    """Encrypts the keyring under a passkey PRF output (with its credential ID) or a recovery key."""
    if (prf is None) == (recovery is None):
        _fail("Pass prf or recovery.")
    kind = "prf" if prf is not None else "recovery"
    key, aad = _wrapping(kind, prf if prf is not None else recovery, credential_id)
    iv = _random(12)
    ct = AESGCM(key).encrypt(iv, canon(_check_keyring(keyring)).encode(), aad)
    extra = {"credentialId": credential_id} if kind == "prf" else {}
    return {"v": 1, "kind": kind, **extra, "iv": b64u_encode(iv), "ct": b64u_encode(ct)}


def unwrap_keyring(wrapped: dict, secret: BytesLike) -> dict:
    """`secret` is the PRF output or the recovery key bytes, matching `wrapped["kind"]`."""
    if wrapped.get("v") != 1 or wrapped.get("kind") not in ("prf", "recovery"):
        _fail("Unsupported backup.")
    key, aad = _wrapping(wrapped["kind"], secret, wrapped.get("credentialId"))
    plain = _aes_decrypt(key, _bytes(wrapped["iv"], 12), aad, b64u_decode(wrapped["ct"]))
    return _check_keyring(json.loads(plain.decode("utf-8")))


# Device approval: commitment, challenge, four-digit code, keyring sealed to a transfer key.


@dataclass(frozen=True)
class TransferKey:
    seed: str
    kid: str
    box_pub: str
    box_priv: X25519PrivateKey


def transfer_key(seed=None) -> TransferKey:
    """A one-time X25519 key; keep `seed` to resume later."""
    raw = _random(32) if seed is None else _bytes(seed, 32)
    priv = X25519PrivateKey.from_private_bytes(raw)
    pub = _raw_pub(priv)
    return TransferKey(b64u_encode(raw), _kid(pub), b64u_encode(pub), priv)


def approval_nonce() -> str:
    return b64u_encode(_random(32))


def device_commit(transfer_pub: str, nonce: str) -> str:
    return b64u_encode(H("commit", _bytes(transfer_pub, 32), _bytes(nonce, 32)))


def approval_code(transfer_pub: str, device_nonce: str, approver_nonce: str) -> str:
    h = H("code", _bytes(transfer_pub, 32), _bytes(device_nonce, 32), _bytes(approver_nonce, 32))
    return f"{int.from_bytes(h[:4], 'big') % 10000:04d}"


def seal_keyring(keyring: dict, device_id: str, transfer_pub: str) -> dict:
    keys = keyring_keys(keyring)
    to = [{"kid": _kid(_bytes(transfer_pub, 32)), "box": transfer_pub}]
    return seal(payload=dict(keyring), ctx={"t": "keyring", "account": keyring["account"], "device": device_id}, signer=keys.identity, to=to)


def open_keyring(env: dict, transfer, device_id: str, account: Optional[str] = None) -> dict:
    """Decrypts, then verifies the signature with the identity key inside the keyring."""
    head = _check_envelope(env)
    keyring = _check_keyring(_decrypt_payload(env, head, _unwrap_key(env, head, [transfer])))
    keys = keyring_keys(keyring)
    if env["from"] != keys.signer_kid:
        _fail("Keyring not signed by its identity.")
    _verify_sig(env, head, keys.identity.sign_pub)
    _check_ctx(env["ctx"], {"t": "keyring", "account": account if account is not None else keyring["account"], "device": device_id})
    if env["ctx"]["account"] != keyring["account"]:
        _fail("Context mismatch: account.")
    return keyring


# Tokens: `hdr_<auth>.<seed>.<fingerprint>`; only `hdr_<auth>` goes to the server.


def parse_token(token: str) -> dict:
    parts = token.strip().split(".")
    if len(parts) == 1 and parts[0]:
        return {"auth": parts[0]}
    if len(parts) != 3 or not parts[0]:
        _fail("Malformed token.")
    _bytes(parts[1], 32)
    _bytes(parts[2], 16)
    return {"auth": parts[0], "seed": parts[1], "fingerprint": parts[2]}


def format_token(auth: str, seed: str, fingerprint: str) -> str:
    if not auth or "." in auth:
        _fail("Malformed token.")
    token = f"{auth}.{seed}.{fingerprint}"
    parse_token(token)
    return token


# Team workspaces: a succession chain of workspace identities, one signed roster, team keys.

_MAX_LINKS = 256
_CAPS = ("connect", "keys")
_MEMBER_SIGNED = ("response", "task", "secret")


def _int(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= _MAX_INT


def _text(value, most=200):
    return isinstance(value, str) and 0 < len(value) <= most


def link_digest(statement: dict) -> str:
    """`b64u(H("link", canon(statement)))`: a link's digest, pinned and chained by `prev`."""
    return b64u_encode(H("link", canon(statement)))


def roster_digest(roster: dict) -> str:
    """`b64u(H("roster", canon(roster)))`: the digest a client pins with the epoch."""
    return b64u_encode(H("roster", canon(roster)))


def signer_kid(identity: str) -> str:
    """A member's or workspace identity's signer kid."""
    return _kid(_bytes(identity, 32))


@dataclass(frozen=True)
class WorkspaceIdentity(KeySet):
    """A workspace identity key set: `kid` signs, `box_kid` receives."""

    box_kid: str = ""


def workspace_identity(seed=None) -> WorkspaceIdentity:
    s = key_set(seed)
    pub = _bytes(s.sign_pub, 32)
    return WorkspaceIdentity(s.seed, _kid(pub), s.sign_pub, s.box_pub, s.sign_priv, s.box_priv, _kid(pub, _bytes(s.box_pub, 32)))


@dataclass(frozen=True)
class RecoveryOpener:
    """The workspace recovery key's X25519 opener; only `box_pub` is published."""

    kid: str
    box_pub: str
    box_priv: X25519PrivateKey


def recovery_key_set(recovery: BytesLike) -> RecoveryOpener:
    priv = X25519PrivateKey.from_private_bytes(_hkdf(_bytes(recovery, 32), "herald/e2ee/v1 recovery-ws"))
    pub = _raw_pub(priv)
    return RecoveryOpener(_kid(pub), b64u_encode(pub), priv)


def team_key_set(seed, root: str) -> KeySet:
    """A team key version from its seed; `kid` is `kid(root, box)`."""
    s = key_set(seed)
    return replace(s, kid=_kid(_bytes(root, 32), _bytes(s.box_pub, 32)))


def workspace_link(*, workspace: str, identity: WorkspaceIdentity, recovery: str, prev: Optional[dict] = None, prev_identity: Optional[WorkspaceIdentity] = None) -> dict:
    """A new chain link; `prev` is the current head link, signed over by `prev_identity`."""
    _bytes(recovery, 32)
    statement = {"v": 1, "workspace": workspace, "n": prev["statement"]["n"] + 1 if prev else 0, "identity": identity.sign_pub, "box": identity.box_pub, "recovery": recovery}
    if prev:
        statement["prev"] = link_digest(prev["statement"])
    statement["created"] = _now()
    link = {"statement": statement, "sig": b64u_encode(identity.sign_priv.sign(H("workspace", canon(statement))))}
    if prev:
        if prev_identity is None or prev_identity.sign_pub != prev["statement"]["identity"]:
            _fail("Wrong previous identity.")
        link["prevSig"] = b64u_encode(prev_identity.sign_priv.sign(H("succession", canon(statement))))
    return link


@dataclass(frozen=True)
class VerifiedWorkspace:
    workspace: str
    root: str
    head: dict
    identities: dict
    epoch: int = 0
    digest: str = ""
    members: dict = None
    teams: dict = None
    pin: dict = None


def _check_pin(pin, workspace):
    if pin is not None and parse_workspace_pin(pin)["workspace"] != workspace:
        _fail("Workspace pin mismatch.")
    return pin


def _digest_text(value):
    return isinstance(value, str) and re.fullmatch(r"[\w-]{43}", value, re.ASCII) is not None


def parse_workspace_pin(value) -> dict:
    """A pin from its JSON text (`HERALD_PIN`, a pin file) or dict; malformed pins fail."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            value = None
    p = value if isinstance(value, dict) else {}
    ok = _text(p.get("workspace")) and p["workspace"].startswith("ws_") and _int(p.get("n")) and _int(p.get("epoch")) and p["epoch"] >= 1 and _digest_text(p.get("link")) and _digest_text(p.get("roster"))
    if not ok:
        _fail("Malformed workspace pin.")
    return {k: p[k] for k in ("workspace", "n", "link", "epoch", "roster")}


def check_newer_pin(pin: dict, new: dict) -> None:
    """Fails unless `new` is the same as or newer than `pin` (no rollback, fork or stale roster)."""
    if pin["workspace"] != new["workspace"]:
        _fail("Workspace pin mismatch.")
    if new["n"] < pin["n"]:
        _fail("Workspace chain rollback.")
    if new["n"] == pin["n"] and new["link"] != pin["link"]:
        _fail("Workspace chain fork.")
    if new["epoch"] < pin["epoch"] or (new["epoch"] == pin["epoch"] and new["roster"] != pin["roster"]):
        _fail("Stale roster epoch.")


def keyring_pin(keyring: dict, *, workspace: str, fingerprint: str, pin: Optional[dict] = None) -> dict:
    """Records a workspace anchor (root fingerprint, newest pin) in the personal keyring; a stored root is never replaced and a stored pin never goes back."""
    if not _text(workspace) or not workspace.startswith("ws_") or not isinstance(fingerprint, str) or not re.fullmatch(r"[\w-]{22}", fingerprint, re.ASCII):
        _fail("Malformed workspace anchor.")
    pin = parse_workspace_pin(pin) if pin is not None else None
    if pin is not None and pin["workspace"] != workspace:
        _fail("Workspace pin mismatch.")
    entries = keyring.get("workspaces") or []
    old = next((w for w in entries if w.get("workspace") == workspace), None)
    if old is not None and old.get("fingerprint") != fingerprint:
        _fail("Workspace fingerprint mismatch.")
    if old is not None and old.get("pin") and pin is not None:
        check_newer_pin(old["pin"], pin)
    keep = pin or (old or {}).get("pin")
    entry = {"workspace": workspace, "fingerprint": fingerprint, **({"pin": keep} if keep else {})}
    return {**keyring, "workspaces": [w for w in entries if w is not old] + [entry]}


def verify_chain(chain: list, pinned_fp: str, *, workspace: Optional[str] = None, pin: Optional[dict] = None) -> VerifiedWorkspace:
    """Verifies the chain from the pinned root fingerprint to its head, against a pinned head."""
    if not isinstance(chain, list) or not 0 < len(chain) <= _MAX_LINKS:
        _fail("Malformed workspace chain.")
    ws = ((chain[0] or {}).get("statement") or {}).get("workspace") if isinstance(chain[0], dict) else None
    if not _text(ws) or not ws.startswith("ws_"):
        _fail("Malformed workspace chain.")
    if workspace is not None and ws != workspace:
        _fail("Workspace mismatch.")
    pin = _check_pin(pin, ws)
    if fingerprint(chain[0]["statement"]["identity"]) != pinned_fp:
        _fail("Workspace fingerprint mismatch.")
    identities, prev, digest = {}, None, ""
    for i, link in enumerate(chain):
        s = link.get("statement") if isinstance(link, dict) else None
        if not isinstance(s, dict) or s.get("v") != 1 or s.get("n") != i or isinstance(s.get("n"), bool) or s.get("workspace") != ws or not _text(s.get("created"), 40):
            _fail("Malformed workspace chain.")
        for key in ("identity", "box", "recovery"):
            _bytes(s.get(key), 32)
        if not _verify(s["identity"], link.get("sig"), H("workspace", canon(s))):
            _fail("Bad workspace link signature.")
        if prev is not None:
            if s.get("prev") != digest:
                _fail("Workspace chain is broken.")
            if not _verify(prev["identity"], link.get("prevSig") or "", H("succession", canon(s))):
                _fail("Bad workspace succession signature.")
        elif "prev" in s or "prevSig" in link:
            _fail("Malformed workspace chain.")
        digest = link_digest(s)
        if pin is not None and i == pin["n"] and digest != pin["link"]:
            _fail("Workspace chain fork.")
        identities[signer_kid(s["identity"])] = s["identity"]
        prev = s
    if pin is not None and len(chain) <= pin["n"]:
        _fail("Workspace chain rollback.")
    head_id = _bytes(prev["identity"], 32)
    head = {"n": prev["n"], "link": digest, "identity": prev["identity"], "box": prev["box"], "recovery": prev["recovery"], "signerKid": _kid(head_id), "boxKid": _kid(head_id, _bytes(prev["box"], 32)), "recoveryKid": _kid(_bytes(prev["recovery"], 32))}
    return VerifiedWorkspace(ws, chain[0]["statement"]["identity"], head, identities)


def sign_roster(*, epoch: int, members: list, teams: list, head: dict, identity: WorkspaceIdentity) -> dict:
    """Signs a roster as the chain head; `head` is the current head link."""
    if identity.sign_pub != head["statement"]["identity"]:
        _fail("Rosters are signed by the chain head.")
    roster = {"v": 1, "workspace": head["statement"]["workspace"], "epoch": epoch, "n": head["statement"]["n"], "head": link_digest(head["statement"]), "members": members, "teams": teams, "created": _now()}
    return {"roster": roster, "sig": b64u_encode(identity.sign_priv.sign(H("roster", canon(roster))))}


def verify_roster(signed: dict, chain: VerifiedWorkspace, *, pin: Optional[dict] = None, min_epoch: Optional[int] = None) -> VerifiedWorkspace:
    """Verifies a roster against a verified chain: signed by the head, not older than the pin or `min_epoch`, and well formed."""
    r = (signed or {}).get("roster") or {}
    if r.get("v") != 1 or r.get("workspace") != chain.workspace or not _int(r.get("epoch")) or r["epoch"] < 1:
        _fail("Malformed roster.")
    if r.get("n") != chain.head["n"] or r.get("head") != chain.head["link"]:
        _fail("Roster is not signed by the head.")
    if not _verify(chain.head["identity"], signed.get("sig"), H("roster", canon(r))):
        _fail("Bad roster signature.")
    digest = roster_digest(r)
    pin = _check_pin(pin, chain.workspace)
    if pin is not None and (r["epoch"] < pin["epoch"] or (r["epoch"] == pin["epoch"] and digest != pin["roster"])):
        _fail("Stale roster epoch.")
    if min_epoch is not None and r["epoch"] < min_epoch:
        _fail("Stale roster epoch.")
    if not isinstance(r.get("members"), list) or not isinstance(r.get("teams"), list):
        _fail("Malformed roster.")
    if len(r["members"]) > 500 or len(r["teams"]) > 100:
        _fail("Roster is too large.")
    teams, slugs, root = {}, set(), _bytes(chain.root, 32)
    for t in r["teams"]:
        if not isinstance(t, dict) or not _text(t.get("id")) or not _text(t.get("slug"), 64) or t["id"] in teams or t["slug"] in slugs:
            _fail("Malformed roster team.")
        if not isinstance(t.get("keys"), list) or not 0 < len(t["keys"]) <= 1000:
            _fail("Malformed roster team.")
        kids = [_kid(root, _bytes(box, 32)) for box in t["keys"]]
        slugs.add(t["slug"])
        teams[t["id"]] = {**t, "kv": len(t["keys"]), "box": t["keys"][-1], "kid": kids[-1], "kids": kids}
    members = {}
    for m in r["members"]:
        caps = m.get("caps") if isinstance(m, dict) else None
        ok = (
            isinstance(m, dict) and _text(m.get("user")) and m["user"] not in members and _text(m.get("name"), 100)
            and isinstance(caps, list) and all(c in _CAPS for c in caps) and len(set(caps)) == len(caps)
            and isinstance(m.get("teams"), list) and all(isinstance(x, str) and x in teams for x in m["teams"]) and len(set(m["teams"])) == len(m["teams"])
        )
        if not ok:
            _fail("Malformed roster member.")
        identity = _bytes(m.get("identity"), 32)
        members[m["user"]] = {**m, "kid": _kid(identity), "inboxKid": _kid(identity, _bytes(m.get("inbox"), 32))}
    new_pin = {"workspace": chain.workspace, "n": chain.head["n"], "link": chain.head["link"], "epoch": r["epoch"], "roster": digest}
    return replace(chain, epoch=r["epoch"], digest=digest, members=members, teams=teams, pin=new_pin)


def verify_workspace(directory: dict, pinned_fp: str, *, workspace: Optional[str] = None, pin: Optional[dict] = None, min_epoch: Optional[int] = None) -> VerifiedWorkspace:
    """Verifies `GET /keys`' `workspace` part under the token's pinned root fingerprint."""
    if not isinstance(directory, dict):
        _fail("Malformed workspace directory.")
    chain = verify_chain(directory.get("chain"), pinned_fp, workspace=workspace, pin=pin)
    return verify_roster(directory.get("roster"), chain, pin=pin, min_epoch=min_epoch)


def certify_workspace(*, workspace: str, sign: str, box: str, teams: list, epoch: int, signer, by: Optional[str] = None) -> dict:
    """Certifies an integration key set in a workspace; `signer` is the head identity, or with `by` that member's personal identity."""
    body = {"v": 1, "account": workspace, "kid": _kid(_bytes(sign, 32), _bytes(box, 32)), "sign": sign, "box": box, "created": _now(), "teams": teams, "epoch": epoch}
    if by is not None:
        body["by"] = by
    return {"certificate": body, "sig": b64u_encode(signer.sign_priv.sign(H("cert", canon(body))))}


def verify_workspace_certificate(cert: dict, ws: VerifiedWorkspace) -> dict:
    """Checks a workspace certificate: signed by the head identity, or by a roster member with `connect` (`by`)."""
    body = (cert or {}).get("certificate") or {}
    if body.get("v") != 1:
        _fail("Unsupported certificate version.")
    if body.get("account") != ws.workspace:
        _fail("Certificate account mismatch.")
    if body.get("kid") != _kid(_bytes(body.get("sign"), 32), _bytes(body.get("box"), 32)):
        _fail("Certificate kid mismatch.")
    if not _int(body.get("epoch")) or not isinstance(body.get("teams"), list) or not body["teams"]:
        _fail("Not a workspace certificate.")
    if body["epoch"] > ws.epoch:
        _fail("Stale roster epoch.")
    signer, allowed = ws.head["identity"], ws.teams
    if "by" in body:
        member = ws.members.get(body["by"]) if isinstance(body["by"], str) else None
        if member is None:
            _fail("Unknown certifier.")
        if "connect" not in member["caps"]:
            _fail("The certifier may not connect integrations.")
        signer, allowed = member["identity"], member["teams"]
    if not _verify(signer, cert.get("sig"), H("cert", canon(body))):
        _fail("Bad certificate signature.")
    teams = [t for t in dict.fromkeys(body["teams"]) if isinstance(t, str) and t in allowed]
    if not teams:
        _fail("The certificate covers no team.")
    return {"kid": body["kid"], "sign": body["sign"], "box": body["box"], "teams": teams, **({"by": body["by"]} if "by" in body else {})}


def recertify_workspace(cert: dict, *, previous: VerifiedWorkspace, current: VerifiedWorkspace, identity: WorkspaceIdentity) -> dict:
    """Re-certifies under the current head a certificate verified under the previous roster (an explicit, confirmed action, never automatic); teams are its effective teams there that still exist."""
    if previous.workspace != current.workspace or previous.epoch >= current.epoch:
        _fail("Not the previous roster.")
    if identity.sign_pub != current.head["identity"]:
        _fail("Certificates are re-signed by the head.")
    checked = verify_workspace_certificate(cert, previous)
    teams = [t for t in checked["teams"] if t in current.teams]
    if not teams:
        _fail("The certificate covers no team.")
    return certify_workspace(workspace=current.workspace, sign=checked["sign"], box=checked["box"], teams=teams, epoch=current.epoch, signer=identity)


def team_member(ws: VerifiedWorkspace, user, team) -> dict:
    """A member of `team` by user id."""
    member = ws.members.get(user) if isinstance(user, str) else None
    if member is None:
        _fail("Not a member.")
    if not isinstance(team, str) or team not in member["teams"]:
        _fail("Not a member of the team.")
    return member


def workspace_signer(ws: VerifiedWorkspace, certificates: dict, ctx: dict, sender: str) -> Optional[str]:
    """The signing key a workspace context allows for kid `sender`: a member of `ctx.team` for answers, tasks and secrets; an integration certified for `ctx.team` (`certificates` by kid) otherwise; only the current head for key wraps."""
    if not isinstance(ctx, dict) or ctx.get("account") != ws.workspace:
        return None
    if ctx.get("t") in ("teamkey", "wskey"):
        return _head_signer(ws, sender)
    if ctx.get("t") in _MEMBER_SIGNED:
        member = team_member(ws, ctx.get("member"), ctx.get("team"))
        return member["identity"] if sender == member["kid"] else None
    cert = certificates.get(sender)
    return cert["sign"] if cert and ctx.get("team") in cert["teams"] else None


def _head_signer(ws, sender):
    # Key wraps are signed by the current head only; a rotation re-wraps under the new head.
    return ws.head["identity"] if sender == ws.head["signerKid"] else None


def _key_recipients(ws, member):
    return [{"kid": member["inboxKid"], "box": member["inbox"]}, {"kid": ws.head["boxKid"], "box": ws.head["box"]}, {"kid": ws.head["recoveryKid"], "box": ws.head["recovery"]}]


def wrap_team_key(*, ws: VerifiedWorkspace, team: str, kv: int, member: str, seed: str, signer) -> dict:
    """Wraps a team key version to a member's inbox, the head box and the recovery key."""
    target = team_member(ws, member, team)
    if (ws.teams.get(team) or {"keys": []})["keys"][kv - 1 : kv] != [team_key_set(seed, ws.root).box_pub]:
        _fail("Unknown team key version.")
    return seal(payload={"seed": seed}, ctx={"t": "teamkey", "account": ws.workspace, "team": team, "kv": kv, "member": member}, signer=signer, to=_key_recipients(ws, target))


def open_team_key(env: dict, *, ws: VerifiedWorkspace, recipients: list, team: str, kv: int, member: str) -> KeySet:
    """Opens a team key wrap; the seed must derive the roster's published key for that version."""
    payload = open(env, recipients=recipients, signers=lambda k: _head_signer(ws, k), expect={"t": "teamkey", "account": ws.workspace, "team": team, "kv": kv, "member": member})
    s = team_key_set(payload.get("seed"), ws.root)
    if kv < 1 or (ws.teams.get(team) or {"keys": []})["keys"][kv - 1 : kv] != [s.box_pub]:
        _fail("Team key does not match the roster.")
    return s


def wrap_workspace_key(*, ws: VerifiedWorkspace, n: int, member: str, seed: str, signer) -> dict:
    """Wraps the identity seed of link `n` to a key holder's inbox and the recovery key."""
    holder = ws.members.get(member) or _fail("Not a member.")
    if "keys" not in holder["caps"]:
        _fail("The member does not hold the workspace key.")
    to = _key_recipients(ws, holder)
    return seal(payload={"seed": seed}, ctx={"t": "wskey", "account": ws.workspace, "n": n, "member": member}, signer=signer, to=[to[0], to[2]])


def open_workspace_key(env: dict, *, ws: VerifiedWorkspace, recipients: list, n: int, member: str) -> WorkspaceIdentity:
    """Opens an identity wrap; the seed must derive the head's identity at link `n`."""
    payload = open(env, recipients=recipients, signers=lambda k: _head_signer(ws, k), expect={"t": "wskey", "account": ws.workspace, "n": n, "member": member})
    identity = workspace_identity(payload.get("seed"))
    if n != ws.head["n"] or identity.sign_pub != ws.head["identity"]:
        _fail("Workspace key does not match the chain.")
    return identity


def invite_secret(identity_seed: str, invite: str) -> bytes:
    """A link invite's secret, recomputable by any device holding the head identity seed."""
    return _hmac(_hkdf(_bytes(identity_seed, 32), "herald/e2ee/v1 invite"), invite.encode())


def invite_fragment(secret: BytesLike, fingerprint: str) -> str:
    """The invite link fragment `<b64u secret>.<fingerprint(root)>`, without `#`."""
    if not isinstance(fingerprint, str) or not re.fullmatch(r"[\w-]{22}", fingerprint, re.ASCII):
        _fail("Malformed fingerprint.")
    return b64u_encode(_bytes(secret, 32)) + "." + fingerprint


def parse_invite_fragment(fragment: str) -> tuple:
    """Reads an invite link fragment (with or without `#`): `(secret, fingerprint)`, the root to pin."""
    match = re.fullmatch(r"#?([\w-]{43})\.([\w-]{22})", fragment, re.ASCII) if isinstance(fragment, str) else None
    if not match:
        _fail("Malformed invite link.")
    return _bytes(match[1], 32), match[2]


def join_proof(secret: BytesLike, *, workspace: str, fingerprint: str, invite: str, user: str, identity: str, inbox: str) -> str:
    """The joiner's proof that it holds the invite link's secret for exactly these keys and pinned root."""
    data = H("join", canon({"workspace": workspace, "fingerprint": fingerprint, "invite": invite, "user": user, "identity": identity, "inbox": inbox}))
    return b64u_encode(_hmac(_bytes(secret, 32), data))


def verify_join_proof(secret: BytesLike, proof: str, **claim) -> None:
    if not isinstance(proof, str) or not hmac.compare_digest(join_proof(secret, **claim), proof):
        _fail("Bad join proof.")
