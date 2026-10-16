import type { Recipient, SealedEnvelope } from '../schema/e2ee';
import { b64u, bytesOf, fail, fromUtf8, utf8, type Bytes } from './bytes';
import { canon } from './canon';
import { H, aesDecrypt, aesEncrypt, hkdf, hmac, sha256 } from './hash';
import { hpkeOpen, hpkeSeal } from './hpke';
import { sign, verify } from './keys';
import { randomBytes } from './random';
export type Ctx = SealedEnvelope['ctx'];
export type Payload = Record<string, unknown>;
export interface Signer {
  kid: string;
  signPriv: CryptoKey;
}
/** A public recipient key: a key set's or certificate's kid and X25519 key (base64url). */
export interface RecipientKey {
  kid: string;
  box: string;
}
/** A private recipient key; a `KeySet` or `TransferKey` fits. */
export interface Opener {
  kid: string;
  boxPub: string;
  boxPriv: CryptoKey;
}
export type Expect = { t: string; account: string } & Record<string, string | number>;
/** Extra context fields per type; `t` and `account` are always present. */
const CTX: Record<string, Record<string, 'string' | 'number'>> = {
  message: { cid: 'string' },
  response: { message: 'string', request: 'string' },
  task: { destination: 'string', type: 'string' },
  log: { task: 'string', seq: 'number' },
  result: { task: 'string' },
  secret: { message: 'string', field: 'string' },
  keyring: { device: 'string' },
};
const KEY_INFO = utf8('herald/e2ee/v1 key');
export function checkCtx(ctx: Ctx, expect?: Expect) {
  if (!ctx || typeof ctx !== 'object' || !Object.hasOwn(CTX, ctx.t)) fail('Unknown context type.');
  const want: Record<string, string> = { t: 'string', account: 'string', ...CTX[ctx.t] };
  for (const key of Object.keys(ctx)) if (!Object.hasOwn(want, key)) fail(`Unexpected ctx.${key}.`);
  for (const [key, type] of Object.entries(want)) {
    const value = ctx[key];
    const ok =
      type === 'number'
        ? Number.isSafeInteger(value) && (value as number) >= 0
        : typeof value === 'string' && value !== '';
    if (!ok) fail(`Invalid ctx.${key}.`);
  }
  if (!expect) return;
  if (typeof expect.t !== 'string' || typeof expect.account !== 'string')
    fail('Expected ctx needs t and account.');
  for (const [key, value] of Object.entries(expect))
    if (ctx[key] !== value) fail(`Context mismatch: ${key}.`);
}
export function withVersion(payload: Payload): Payload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    fail('Payload must be an object.');
  if ('v' in payload && payload.v !== 1) fail('Unsupported payload version.');
  return 'v' in payload ? payload : { v: 1, ...payload };
}
export const headOf = (env: Pick<SealedEnvelope, 'v' | 'ctx' | 'from'>) =>
  H('head', canon({ v: env.v, ctx: env.ctx, from: env.from }));
const sigInput = async (head: Bytes, env: SealedEnvelope) =>
  H('sig', head, await sha256(b64u.decode(env.iv), b64u.decode(env.ct)));
/** Checks the version and field encodings; returns the head. */
export async function checkEnvelope(env: SealedEnvelope): Promise<Bytes> {
  if (!env || env.v !== 1) fail('Unsupported envelope version.');
  if (typeof env.from !== 'string' || !Array.isArray(env.to) || !env.to.length)
    fail('Malformed envelope.');
  bytesOf(env.iv, 12);
  bytesOf(env.sig, 64);
  if (b64u.decode(env.ct).length < 16) fail('Malformed envelope.');
  return headOf(env);
}
export async function verifySig(env: SealedEnvelope, head: Bytes, signPub: Uint8Array | string) {
  if (!(await verify(signPub, env.sig, await sigInput(head, env)))) fail('Bad signature.');
}
export async function unwrapKey(
  env: SealedEnvelope,
  head: Bytes,
  recipients: Opener[],
): Promise<Bytes> {
  for (const entry of env.to) {
    const me = recipients.find((r) => r.kid === entry.kid);
    if (!me) continue;
    const aad = await H('key', head, entry.kid);
    const cek = await hpkeOpen(
      me.boxPriv,
      bytesOf(me.boxPub, 32),
      bytesOf(entry.enc, 32),
      KEY_INFO,
      aad,
      b64u.decode(entry.key),
    );
    return cek.length === 32 ? cek : fail('Malformed content key.');
  }
  return fail('No recipient entry for these keys.');
}
export async function decryptPayload(
  env: SealedEnvelope,
  head: Bytes,
  cek: Uint8Array,
): Promise<Payload> {
  const plain = await aesDecrypt(
    cek,
    b64u.decode(env.iv),
    await H('content', head),
    b64u.decode(env.ct),
  );
  const payload = JSON.parse(fromUtf8(plain));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.v !== 1)
    fail('Unsupported payload version.');
  return payload;
}
async function wrapKey(head: Bytes, cek: Uint8Array, to: RecipientKey): Promise<Recipient> {
  const aad = await H('key', head, to.kid);
  const { enc, ct } = await hpkeSeal(bytesOf(to.box, 32), KEY_INFO, aad, cek);
  return { kid: to.kid, enc: b64u.encode(enc), key: b64u.encode(ct) };
}
/** Encrypts and signs `payload`. A `message` context without `cid` gets a random one. */
export async function seal(input: {
  payload: Payload;
  ctx: Ctx;
  signer: Signer;
  to: RecipientKey[];
}): Promise<SealedEnvelope> {
  const { signer, to } = input;
  if (!to.length || to.length > 16) fail('Seal to 1 to 16 recipients.');
  const ctx =
    input.ctx.t === 'message' && input.ctx.cid === undefined
      ? { ...input.ctx, cid: b64u.encode(randomBytes(16)) }
      : input.ctx;
  checkCtx(ctx);
  const payload = withVersion(input.payload);
  const base = { v: 1 as const, ctx, from: signer.kid };
  const head = await headOf(base);
  const cek = randomBytes(32);
  const iv = randomBytes(12);
  const ct = await aesEncrypt(cek, iv, await H('content', head), utf8(JSON.stringify(payload)));
  const recipients: Recipient[] = [];
  for (const recipient of to) recipients.push(await wrapKey(head, cek, recipient));
  const env = { ...base, to: recipients, iv: b64u.encode(iv), ct: b64u.encode(ct), sig: '' };
  env.sig = await sign(signer.signPriv, await sigInput(head, env));
  return env;
}
/**
 * Verifies the signature against a trusted signer, checks the context, then decrypts.
 * `signers` maps a kid to its trusted Ed25519 public key (the pinned identity or a certified integration).
 */
export async function open<T extends Payload = Payload>(
  env: SealedEnvelope,
  options: {
    recipients: Opener[];
    signers: (kid: string) => Uint8Array | string | undefined;
    expect: Expect;
  },
): Promise<T> {
  const head = await checkEnvelope(env);
  const signPub = options.signers(env.from) ?? fail('Untrusted signer.');
  await verifySig(env, head, signPub);
  checkCtx(env.ctx, options.expect);
  return (await decryptPayload(env, head, await unwrapKey(env, head, options.recipients))) as T;
}
/** Recovers the content key without verifying; open the envelope first. */
export async function openKey(env: SealedEnvelope, recipients: Opener[]): Promise<Bytes> {
  return unwrapKey(env, await checkEnvelope(env), recipients);
}
/** A recipient entry giving another key access to an existing envelope. */
export async function grant(
  env: SealedEnvelope,
  cek: Uint8Array,
  to: RecipientKey,
): Promise<Recipient> {
  return wrapKey(await checkEnvelope(env), bytesOf(cek, 32), to);
}
/** `b64u(SHA-256(iv || ct))`; binds a response to its request. */
export const envelopeDigest = async (env: SealedEnvelope) =>
  b64u.encode(await sha256(b64u.decode(env.iv), b64u.decode(env.ct)));
/** A retry-stable digest of a payload, keyed by the integration seed. */
export async function idempotencyDigest(seed: Uint8Array | string, payload: Payload) {
  const key = await hkdf(bytesOf(seed, 32), 'herald/e2ee/v1 idem');
  return b64u.encode(await hmac(key, utf8(canon(withVersion(payload)))));
}
