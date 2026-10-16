import { concat, fail, utf8, type Bytes } from './bytes';
const EMPTY = new Uint8Array(0);
export async function sha256(...parts: Uint8Array[]): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts)));
}
export async function hmac(key: Uint8Array, ...data: Uint8Array[]): Promise<Bytes> {
  // WebCrypto rejects empty HMAC keys; 32 zero bytes are the same key after padding.
  const raw = key.length ? concat(key) : new Uint8Array(32);
  const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, concat(...data)));
}
export const extract = (salt: Uint8Array, ikm: Uint8Array) => hmac(salt, ikm);
export async function expand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  const blocks: Bytes[] = [];
  let block: Bytes = EMPTY;
  for (let i = 1; blocks.length * 32 < length; i++) {
    block = await hmac(prk, block, info, Uint8Array.of(i));
    blocks.push(block);
  }
  return concat(...blocks).slice(0, length);
}
/** HKDF-SHA256 with an empty salt and an ASCII info label. */
export const hkdf = async (ikm: Uint8Array, info: string, length = 32) =>
  expand(await extract(EMPTY, ikm), utf8(info), length);
/** `H(label, ...parts) = SHA-256("herald/e2ee/v1 " + label || 0x00 || parts...)`; strings are UTF-8. */
export const H = (label: string, ...parts: (Uint8Array | string)[]) =>
  sha256(
    utf8('herald/e2ee/v1 ' + label),
    Uint8Array.of(0),
    ...parts.map((part) => (typeof part === 'string' ? utf8(part) : part)),
  );
async function aesKey(key: Uint8Array, usage: 'encrypt' | 'decrypt') {
  return crypto.subtle.importKey('raw', concat(key), 'AES-GCM', false, [usage]);
}
export async function aesEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  data: Uint8Array,
) {
  const k = await aesKey(key, 'encrypt');
  const params = { name: 'AES-GCM', iv: concat(iv), additionalData: concat(aad) };
  return new Uint8Array(await crypto.subtle.encrypt(params, k, concat(data)));
}
export async function aesDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  data: Uint8Array,
) {
  const k = await aesKey(key, 'decrypt');
  const params = { name: 'AES-GCM', iv: concat(iv), additionalData: concat(aad) };
  try {
    return new Uint8Array(await crypto.subtle.decrypt(params, k, concat(data)));
  } catch {
    return fail('Decryption failed.');
  }
}
