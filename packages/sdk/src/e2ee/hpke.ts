import { concat, utf8, type Bytes } from './bytes';
import { aesDecrypt, aesEncrypt, expand, extract } from './hash';
import { dh, importPrivate } from './keys';
import { randomBytes } from './random';
// HPKE (RFC 9180) base mode, single shot: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-GCM.
// AEAD 0x0002 (AES-256-GCM) is the protocol suite; 0x0001 exists for the RFC test vectors.
export type Aead = 1 | 2;
const EMPTY = new Uint8Array(0);
const VERSION = utf8('HPKE-v1');
const KEM = concat(utf8('KEM'), Uint8Array.of(0, 0x20));
const suite = (aead: Aead) => concat(utf8('HPKE'), Uint8Array.of(0, 0x20, 0, 1, 0, aead));
const labeledExtract = (id: Bytes, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  extract(salt, concat(VERSION, id, utf8(label), ikm));
const labeledExpand = (
  id: Bytes,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
) =>
  expand(
    prk,
    concat(Uint8Array.of(length >> 8, length & 255), VERSION, id, utf8(label), info),
    length,
  );
export async function deriveKeyPair(ikm: Uint8Array) {
  const prk = await labeledExtract(KEM, EMPTY, 'dkp_prk', ikm);
  return importPrivate('X25519', await labeledExpand(KEM, prk, 'sk', EMPTY, 32));
}
async function context(
  dhValue: Bytes,
  enc: Uint8Array,
  pkR: Uint8Array,
  info: Uint8Array,
  aead: Aead,
) {
  const eae = await labeledExtract(KEM, EMPTY, 'eae_prk', dhValue);
  const shared = await labeledExpand(KEM, eae, 'shared_secret', concat(enc, pkR), 32);
  const id = suite(aead);
  const pskIdHash = await labeledExtract(id, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = await labeledExtract(id, EMPTY, 'info_hash', info);
  const scheduleContext = concat(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = await labeledExtract(id, shared, 'secret', EMPTY);
  return {
    key: await labeledExpand(id, secret, 'key', scheduleContext, aead === 1 ? 16 : 32),
    nonce: await labeledExpand(id, secret, 'base_nonce', scheduleContext, 12),
  };
}
export async function hpkeSeal(
  pkR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  pt: Uint8Array,
  aead: Aead = 2,
) {
  const ephemeral = await deriveKeyPair(randomBytes(32));
  const ctx = await context(await dh(ephemeral.priv, pkR), ephemeral.pub, pkR, info, aead);
  return { enc: ephemeral.pub, ct: await aesEncrypt(ctx.key, ctx.nonce, aad, pt) };
}
export async function hpkeOpen(
  skR: CryptoKey,
  pkR: Uint8Array,
  enc: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ct: Uint8Array,
  aead: Aead = 2,
) {
  const ctx = await context(await dh(skR, enc), enc, pkR, info, aead);
  return aesDecrypt(ctx.key, ctx.nonce, aad, ct);
}
