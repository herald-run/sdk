import type { WrappedKeyring } from '../schema/e2ee';
import { b64u, bytesOf, fail, fromUtf8, utf8, type Bytes } from './bytes';
import { canon } from './canon';
import { H, aesDecrypt, aesEncrypt, hkdf } from './hash';
import { checkKeyring, type Keyring } from './keyring';
import { randomBytes } from './random';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The WebAuthn PRF input (`eval.first`) for passkey backups. */
export const prfSalt = () => H('prf-salt');
// Recovery keys: 32 bytes as Crockford base32 (most significant bit first), groups of four.
function base32(bytes: Uint8Array) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const n of bytes) {
    value = ((value << 8) | n) & 0xfff;
    bits += 8;
    for (; bits >= 5; bits -= 5) out += CROCKFORD[(value >> (bits - 5)) & 31];
  }
  if (bits) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}
export function recoveryKey(): { bytes: Bytes; text: string } {
  const bytes = randomBytes(32);
  return { bytes, text: base32(bytes) };
}
/** Reads a recovery key, ignoring case, spaces and dashes, with O as 0 and I or L as 1. */
export function parseRecoveryKey(text: string): Bytes {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length !== 52 || [...clean].some((c) => !CROCKFORD.includes(c)))
    fail('Invalid recovery key.');
  const out = new Uint8Array(32);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const c of clean) {
    value = ((value << 5) | CROCKFORD.indexOf(c)) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 255;
    }
  }
  if (value & ((1 << bits) - 1)) fail('Invalid recovery key.');
  return out;
}
export type BackupSecret =
  | { kind: 'prf'; prf: Uint8Array; credentialId: string }
  | { kind: 'recovery'; recovery: Uint8Array };
async function wrapping(kind: 'prf' | 'recovery', secret: Uint8Array, credentialId?: string) {
  if (kind === 'prf')
    return {
      key: await hkdf(secret, 'herald/e2ee/v1 prf-wrap'),
      aad: await H('wrap', 'prf', b64u.decode(credentialId ?? fail('Missing credentialId.'))),
    };
  return {
    key: await hkdf(bytesOf(secret, 32), 'herald/e2ee/v1 recovery-wrap'),
    aad: await H('wrap', 'recovery'),
  };
}
/** Encrypts the keyring under a passkey PRF output or a recovery key. */
export async function wrapKeyring(keyring: Keyring, secret: BackupSecret): Promise<WrappedKeyring> {
  const { key, aad } =
    secret.kind === 'prf'
      ? await wrapping('prf', secret.prf, secret.credentialId)
      : await wrapping('recovery', secret.recovery);
  const iv = randomBytes(12);
  const ct = await aesEncrypt(key, iv, aad, utf8(canon(checkKeyring(keyring))));
  const id = secret.kind === 'prf' ? { credentialId: secret.credentialId } : {};
  return { v: 1, kind: secret.kind, ...id, iv: b64u.encode(iv), ct: b64u.encode(ct) };
}
/** `secret` is the PRF output or the recovery key bytes, matching `wrapped.kind`. */
export async function unwrapKeyring(wrapped: WrappedKeyring, secret: Uint8Array): Promise<Keyring> {
  if (wrapped?.v !== 1 || (wrapped.kind !== 'prf' && wrapped.kind !== 'recovery'))
    fail('Unsupported backup.');
  const { key, aad } = await wrapping(wrapped.kind, secret, wrapped.credentialId);
  const plain = await aesDecrypt(key, bytesOf(wrapped.iv, 12), aad, b64u.decode(wrapped.ct));
  return checkKeyring(JSON.parse(fromUtf8(plain)));
}
