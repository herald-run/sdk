"""Secret envelopes, compatible with the TypeScript SDK: RSA-OAEP-256 wraps an AES-256-GCM key."""
import base64
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .models import Envelope

OAEP = padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None)


def _b64url(number):
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _int(value):
    return int.from_bytes(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)), "big")


def create_keys():
    """A request key pair as JWK dicts: send `public_key` with the form, keep `private_key` private."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv, pub = key.private_numbers(), key.public_key().public_numbers()
    public = {"kty": "RSA", "n": _b64url(pub.n), "e": _b64url(pub.e), "alg": "RSA-OAEP-256", "ext": True, "key_ops": ["encrypt"]}
    private = {**public, "key_ops": ["decrypt"], "d": _b64url(priv.d), "p": _b64url(priv.p), "q": _b64url(priv.q), "dp": _b64url(priv.dmp1), "dq": _b64url(priv.dmq1), "qi": _b64url(priv.iqmp)}
    return public, private


def _public(jwk):
    return rsa.RSAPublicNumbers(_int(jwk["e"]), _int(jwk["n"])).public_key()


def _private(jwk):
    public = rsa.RSAPublicNumbers(_int(jwk["e"]), _int(jwk["n"]))
    return rsa.RSAPrivateNumbers(_int(jwk["p"]), _int(jwk["q"]), _int(jwk["d"]), _int(jwk["dp"]), _int(jwk["dq"]), _int(jwk["qi"]), public).private_key()


def seal(value, public_key):
    """Encrypts `value` to a receiver's public JWK."""
    aes, iv = AESGCM.generate_key(bit_length=256), os.urandom(12)
    data = AESGCM(aes).encrypt(iv, value.encode(), None)
    encode = lambda raw: base64.b64encode(raw).decode()
    return Envelope(key=encode(_public(public_key).encrypt(aes, OAEP)), iv=encode(iv), data=encode(data))


def unseal(envelope, private_key):
    """Decrypts an envelope with the private JWK whose public key the request carried."""
    if not isinstance(envelope, Envelope):
        envelope = Envelope.model_validate(envelope)
    aes = _private(private_key).decrypt(base64.b64decode(envelope.key), OAEP)
    return AESGCM(aes).decrypt(base64.b64decode(envelope.iv), base64.b64decode(envelope.data), None).decode()
