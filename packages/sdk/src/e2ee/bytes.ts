/** Bytes backed by a plain ArrayBuffer, as WebCrypto expects. */
export type Bytes = Uint8Array<ArrayBuffer>;
export class E2eeError extends Error {
  override name = 'E2eeError';
}
export const fail = (message: string): never => {
  throw new E2eeError(message);
};
const B64U = /^[A-Za-z0-9_-]*$/;
/** Base64url without padding. Decoding rejects padding, foreign characters and non-canonical text. */
export const b64u = {
  encode(bytes: Uint8Array): string {
    let text = '';
    for (const n of bytes) text += String.fromCharCode(n);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(text: string): Bytes {
    if (typeof text !== 'string' || !B64U.test(text) || text.length % 4 === 1)
      fail('Invalid base64url.');
    const out = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
    if (b64u.encode(out) !== text) fail('Invalid base64url.');
    return out;
  },
};
const encoder = new TextEncoder();
export const utf8 = (text: string): Bytes => encoder.encode(text) as Bytes;
export const fromUtf8 = (bytes: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
/** Copies bytes, or decodes a base64url string; checks the length when one is given. */
export function bytesOf(value: Uint8Array | string, length?: number): Bytes {
  const out = typeof value === 'string' ? b64u.decode(value) : new Uint8Array(value);
  if (length !== undefined && out.length !== length) fail(`Expected ${length} bytes.`);
  return out;
}
export const hex = (text: string): Bytes =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));
