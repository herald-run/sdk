import { b64u, bytesOf, concat, fail, hex, type Bytes } from './bytes';
import { H, hkdf } from './hash';
import { randomBytes } from './random';
const PKCS8 = {
  Ed25519: hex('302e020100300506032b657004220420'),
  X25519: hex('302e020100300506032b656e04220420'),
};
/** Imports a raw 32-byte private key and returns it with its public key. */
export async function importPrivate(alg: 'Ed25519' | 'X25519', raw: Uint8Array) {
  const usages: ('sign' | 'deriveBits')[] = alg === 'Ed25519' ? ['sign'] : ['deriveBits'];
  const der = concat(PKCS8[alg], bytesOf(raw, 32));
  const priv = await crypto.subtle.importKey('pkcs8', der, { name: alg }, true, usages);
  const { x } = (await crypto.subtle.exportKey('jwk', priv)) as JsonWebKey;
  return { priv, pub: b64u.decode(x!) };
}
// Typed loosely: DOM and Workers typings name the `public` member differently.
const x25519 = (key: CryptoKey) =>
  ({ name: 'X25519', public: key }) as unknown as Parameters<SubtleCrypto['deriveBits']>[0];
export async function dh(priv: CryptoKey, pub: Uint8Array): Promise<Bytes> {
  let out: Bytes | undefined;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      bytesOf(pub, 32),
      { name: 'X25519' },
      false,
      [],
    );
    out = new Uint8Array(
      await crypto.subtle.deriveBits(x25519(key), priv, 256),
    );
  } catch {
    fail('Invalid X25519 public key.');
  }
  if (out!.every((n) => n === 0)) fail('Invalid X25519 public key.');
  return out!;
}
export async function sign(priv: CryptoKey, message: Uint8Array): Promise<string> {
  return b64u.encode(new Uint8Array(await crypto.subtle.sign('Ed25519', priv, concat(message))));
}
export async function verify(pub: Uint8Array | string, sig: string, message: Uint8Array) {
  try {
    const key = await crypto.subtle.importKey('raw', bytesOf(pub, 32), 'Ed25519', false, [
      'verify',
    ]);
    return await crypto.subtle.verify('Ed25519', key, bytesOf(sig, 64), concat(message));
  } catch {
    return false;
  }
}
/** `b64u(H("kid", ...parts)[0:16])`. */
export const kid = async (...parts: Uint8Array[]) =>
  b64u.encode((await H('kid', ...parts)).slice(0, 16));
/** The account safety code: `b64u(H("fp", identitySignPub)[0:16])`. */
export const fingerprint = async (identitySignPub: Uint8Array | string) =>
  b64u.encode((await H('fp', bytesOf(identitySignPub, 32))).slice(0, 16));
/** Public parts are base64url; `signPriv` and `boxPriv` are WebCrypto keys. */
export interface KeySet {
  seed: string;
  kid: string;
  signPub: string;
  boxPub: string;
  signPriv: CryptoKey;
  boxPriv: CryptoKey;
}
/** An Ed25519 signing key and an X25519 box key derived from one 32-byte seed. */
export async function keySet(seed?: Uint8Array | string): Promise<KeySet> {
  const raw = seed === undefined ? randomBytes(32) : bytesOf(seed, 32);
  const signing = await importPrivate('Ed25519', await hkdf(raw, 'herald/e2ee/v1 sign'));
  const box = await importPrivate('X25519', await hkdf(raw, 'herald/e2ee/v1 box'));
  return {
    seed: b64u.encode(raw),
    kid: await kid(signing.pub, box.pub),
    signPub: b64u.encode(signing.pub),
    boxPub: b64u.encode(box.pub),
    signPriv: signing.priv,
    boxPriv: box.priv,
  };
}
