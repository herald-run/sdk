import { expect, it } from 'vitest';
import type { SealedEnvelope } from '../schema/e2ee';
import { sealedEnvelopeSchema } from '../schema/e2ee';
import { b64u, E2eeError } from './bytes';
import {
  accountStatement,
  certify,
  createKeyring,
  envelopeDigest,
  grant,
  idempotencyDigest,
  keyringKeys,
  keySet,
  open,
  openKey,
  seal,
  verifyAccount,
  verifyCertificate,
  fingerprint,
  type Ctx,
  type Expect,
  type Opener,
} from './index';
const account = 'acct-1';
const keyring = createKeyring(account);
const keys = await keyringKeys(keyring);
const integration = await keySet();
const destination = await keySet();
const outsider = await keySet();
const fp = await fingerprint(keys.identity.signPub);
const info = await verifyAccount(await accountStatement(keyring), fp, account);
const trusted = new Map([[info.signerKid, info.identity]]);
for (const set of [integration, destination]) {
  const cert = await certify(keyring, { sign: set.signPub, box: set.boxPub });
  const verified = await verifyCertificate(cert, info.identity, account);
  trusted.set(verified.kid, verified.sign);
}
const signers = (kid: string) => trusted.get(kid);
const inbox = { kid: info.inboxKid, box: info.inbox };
const to = (set: { kid: string; boxPub: string }) => ({ kid: set.kid, box: set.boxPub });
const message = '6f1c1a4e-58d3-4f9c-9a38-7f0d1c2b3a4d';
const other = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const cases: { ctx: Ctx; signer: 'account' | 'integration'; to: Opener[] }[] = [
  {
    ctx: { t: 'message', account, id: message },
    signer: 'integration',
    to: [keys.inbox[0], integration],
  },
  {
    ctx: { t: 'response', account, message, request: 'x'.repeat(43) },
    signer: 'account',
    to: [keys.inbox[0], integration],
  },
  {
    ctx: { t: 'task', account, id: other, destination: message, type: 'deploy' },
    signer: 'account',
    to: [keys.inbox[0], destination],
  },
  {
    ctx: { t: 'log', account, task: message, seq: 0 },
    signer: 'integration',
    to: [keys.inbox[0], integration],
  },
  {
    ctx: { t: 'result', account, task: message },
    signer: 'integration',
    to: [keys.inbox[0], integration],
  },
  {
    ctx: { t: 'secret', account, message, field: 'password' },
    signer: 'account',
    to: [integration],
  },
];
const payload = { title: 'Deploy? ✓', fields: [{ value: 0.5 }] };
async function sealed(ctx: Ctx = cases[0].ctx) {
  return seal({ payload, ctx, signer: integration, to: [inbox, to(integration)] });
}
const expectOf = (env: SealedEnvelope) => env.ctx as Expect;
it('round trips every context type for every recipient', async () => {
  for (const c of cases) {
    const recipients = c.to.map((r) => (r === keys.inbox[0] ? inbox : to(r)));
    const signer = c.signer === 'account' ? keys.identity : integration;
    const env = await seal({ payload, ctx: c.ctx, signer, to: recipients });
    expect(sealedEnvelopeSchema.parse(env)).toEqual(env);
    for (const r of c.to)
      expect(await open(env, { recipients: [r], signers, expect: expectOf(env) })).toEqual({
        v: 1,
        ...payload,
      });
  }
});
const tamper = (text: string) => {
  const bytes = b64u.decode(text);
  bytes[0] ^= 1;
  return b64u.encode(bytes);
};
it('rejects tampering, untrusted signers, wrong recipients and wrong contexts', async () => {
  const env = await sealed();
  const expect_ = expectOf(env);
  const bad: [string, SealedEnvelope, Partial<{ expect: Expect; recipients: Opener[] }>][] = [
    ['Bad signature', { ...env, ct: tamper(env.ct) }, {}],
    ['Bad signature', { ...env, iv: tamper(env.iv) }, {}],
    ['Bad signature', { ...env, sig: tamper(env.sig) }, {}],
    [
      'Bad signature',
      { ...env, ctx: { ...env.ctx, id: other } },
      { expect: { t: 'message', account } },
    ],
    ['Bad signature', { ...env, from: info.signerKid }, {}],
    ['Decryption failed', { ...env, to: [{ ...env.to[0], key: tamper(env.to[0].key) }] }, {}],
    ['Decryption failed', { ...env, to: [{ ...env.to[0], enc: env.to[1].enc }] }, {}],
    ['Decryption failed', { ...env, to: [{ ...env.to[1], kid: env.to[0].kid }] }, {}],
    ['No recipient entry', env, { recipients: [outsider] }],
    ['Context mismatch: account', env, { expect: { ...expect_, account: 'other' } }],
    ['Context mismatch: t', env, { expect: { ...expect_, t: 'log' } }],
    ['Context mismatch: id', env, { expect: { ...expect_, id: other } }],
    ['Unsupported envelope version', { ...env, v: 2 as 1 }, {}],
    ['Untrusted signer', { ...env, from: outsider.kid }, {}],
    ['Expected 12 bytes', { ...env, iv: env.iv + 'AA' }, {}],
  ];
  for (const [error, candidate, options] of bad)
    await expect(
      open(candidate, { recipients: keys.inbox, signers, expect: expect_, ...options }),
      error,
    ).rejects.toThrow(error);
});
it('validates contexts and payloads when sealing', async () => {
  const signer = integration;
  const bad: [Ctx, string][] = [
    [{ t: 'nope', account }, 'Unknown context type'],
    [{ t: 'log', account, task: message }, 'Invalid ctx.seq'],
    [{ t: 'log', account, task: message, seq: 1.5 }, 'Invalid ctx.seq'],
    [{ t: 'result', account, task: message, extra: 'x' }, 'Unexpected ctx.extra'],
    [{ t: 'result', account: '', task: message }, 'Invalid ctx.account'],
    [{ t: 'message', account }, 'Invalid ctx.id'],
    [{ t: 'message', account, id: 'not-a-uuid' }, 'Invalid ctx.id'],
    [{ t: 'task', account, destination: message, type: 'deploy' }, 'Invalid ctx.id'],
  ];
  for (const [ctx, error] of bad)
    await expect(seal({ payload, ctx, signer, to: [inbox] }), error).rejects.toThrow(error);
  await expect(seal({ payload: { v: 2 }, ctx: cases[0].ctx, signer, to: [inbox] })).rejects.toThrow(
    'version',
  );
  await expect(seal({ payload, ctx: cases[0].ctx, signer, to: [] })).rejects.toThrow(E2eeError);
  // 50,000 three-byte characters exceed the envelope cap: a clean error, not a schema failure.
  const big = { body: '\u4e2d'.repeat(50_000) };
  await expect(seal({ payload: big, ctx: cases[0].ctx, signer, to: [inbox] })).rejects.toThrow(
    'Content is too large to encrypt',
  );
});
it('grants another key access without re-signing', async () => {
  const env = await sealed();
  const cek = await openKey(env, keys.inbox);
  const extra = await grant(env, cek, to(destination));
  const granted = { ...env, to: [...env.to, extra] };
  expect(
    await open(granted, { recipients: [destination], signers, expect: expectOf(env) }),
  ).toMatchObject(payload);
  const moved = { ...env, ctx: { ...env.ctx, id: other } };
  const forged = { ...moved, to: [await grant(env, cek, to(destination))] };
  await expect(
    open(forged, { recipients: [destination], signers, expect: expectOf(forged) }),
  ).rejects.toThrow('Bad signature');
});
it('digests envelopes and payloads', async () => {
  const env = await sealed();
  expect(await envelopeDigest(env)).toMatch(/^[\w-]{43}$/);
  expect(await envelopeDigest(await sealed())).not.toBe(await envelopeDigest(env));
  const a = await idempotencyDigest(integration.seed, { b: 1, a: [0.5] }, 'k1');
  expect(await idempotencyDigest(integration.seed, { a: [0.5], b: 1, v: 1 }, 'k1')).toBe(a);
  expect(await idempotencyDigest(integration.seed, { a: [0.5], b: 1 }, 'k2')).not.toBe(a);
  expect(await idempotencyDigest(destination.seed, { a: [0.5], b: 1 }, 'k1')).not.toBe(a);
  await expect(idempotencyDigest(integration.seed, {}, '')).rejects.toThrow('idempotency key');
});
