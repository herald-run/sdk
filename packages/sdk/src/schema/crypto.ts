import type { Envelope } from './index';
const encode = (value: ArrayBuffer) =>
  btoa(Array.from(new Uint8Array(value), (n) => String.fromCharCode(n)).join(''));
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export async function createKeys() {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  );
  return {
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
}
export async function seal(value: string, publicKey: JsonWebKey): Promise<Envelope> {
  const rsa = await crypto.subtle.importKey(
    'jwk',
    publicKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return {
    key: encode(
      await crypto.subtle.encrypt(
        { name: 'RSA-OAEP' },
        rsa,
        await crypto.subtle.exportKey('raw', aes),
      ),
    ),
    iv: encode(iv.buffer),
    data: encode(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(value)),
    ),
  };
}
export async function unseal(value: Envelope, privateKey: JsonWebKey): Promise<string> {
  const rsa = await crypto.subtle.importKey(
    'jwk',
    privateKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt'],
  );
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, rsa, decode(value.key));
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv) }, aes, decode(value.data)),
  );
}
