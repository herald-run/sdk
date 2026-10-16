import { afterEach, expect, it, vi } from 'vitest';
import { sealedContracts } from '../fixtures/contracts';
import * as e2ee from './e2ee/index';
import { E2eeError, Herald, HeraldError, type KeyDirectory, type Message } from './index';
afterEach(() => vi.restoreAllMocks());
const { token, keyring, steps } = sealedContracts;
const step = (name: string) => steps.find((s) => s.name === name)!;
const directory = step('keys').response.body as KeyDirectory;
const sent = step('send').response.body as Message;
const url = 'https://herald.test';
/** Routes fetches by `METHOD path` prefix and records every request. */
function serve(routes: Record<string, unknown>) {
  const seen: { route: string; auth: string | null; body?: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const route = `${init?.method || 'GET'} ${new URL(String(input)).pathname}`;
    const auth = new Headers(init?.headers).get('Authorization');
    seen.push({ route, auth, body: init?.body ? String(init.body) : undefined });
    const key = Object.keys(routes).find((r) => route.startsWith(r));
    if (!key) return Response.json({ error: 'Not found.' }, { status: 404 });
    const value = routes[key];
    return value instanceof Response ? value : Response.json(value);
  });
  return seen;
}
async function owner() {
  const keys = await e2ee.keyringKeys(keyring);
  const runner = directory.certificates[0].certificate;
  return {
    signer: { kid: keys.signerKid, signPriv: keys.identity.signPriv },
    to: [
      { kid: keys.inboxKid, box: keys.inbox[0].boxPub },
      { kid: runner.kid, box: runner.box },
    ],
  };
}
const answered = async (values: unknown, request = sent.sealed!) => {
  const { signer, to } = await owner();
  const ctx = {
    t: 'response',
    account: keyring.account,
    message: sent.id,
    request: await e2ee.envelopeDigest(request),
  };
  const sealed = await e2ee.seal({ payload: { values }, ctx, signer, to });
  return { ...sent, status: 'answered', response: { values: {}, secretFields: [], sealed } };
};

it('sends only the auth part of a keyed token', async () => {
  const herald = new Herald({ apiKey: token, url });
  const seed = e2ee.parseToken(token).seed!;
  expect(herald.apiKey).toBe('hdr_test-only');
  const seen = serve({ 'GET /api/v1/keys': directory, 'POST /api/v1/messages': sent });
  await herald.send({ title: 'Hello', body: 'World' });
  expect(seen.map((s) => s.auth)).toEqual(['Bearer hdr_test-only', 'Bearer hdr_test-only']);
  expect(JSON.stringify(seen)).not.toContain(seed);
  expect(JSON.stringify(seen)).not.toContain('World');
  expect(() => new Herald({ apiKey: 'hdr_x.short.fp', url })).toThrow(E2eeError);
  expect(() => new Herald({ apiKey: 'hdr_legacy', url })).toThrow('no end-to-end key');
  // Surrounding whitespace or a missing prefix never sends the seed.
  expect(new Herald({ apiKey: `  ${token}\n`, url }).apiKey).toBe('hdr_test-only');
  expect(new Herald({ apiKey: token.slice(4), url }).apiKey).toBe('test-only');
  expect(new Herald({ apiKey: 'a.b.c', url }).fingerprint).toBeUndefined();
});
it('fails closed without a matching account statement or certificate', async () => {
  const cases = [
    { account: null, certificates: [] },
    { ...directory, certificates: [] },
    { ...directory, account: await e2ee.accountStatement(e2ee.createKeyring('acct-contracts')) },
  ];
  for (const keys of cases) {
    const seen = serve({
      'GET /api/v1/keys': keys,
      'POST /api/v1/messages': sent,
      'GET /api/v1/messages/': sent,
    });
    const herald = new Herald({ apiKey: token, url });
    await expect(herald.send({ title: 'Hello' })).rejects.toThrow(E2eeError);
    await expect(herald.get(sent.id)).rejects.toThrow(E2eeError);
    expect(seen.some((s) => s.route === 'POST /api/v1/messages')).toBe(false);
    vi.restoreAllMocks();
  }
});
it('validates input before sealing and seals secret offers', async () => {
  const seen = serve({ 'GET /api/v1/keys': directory, 'POST /api/v1/messages': sent });
  const herald = new Herald({ apiKey: token, url });
  await expect(herald.send({ title: '' })).rejects.toMatchObject({ status: 400 });
  await expect(
    herald.send({
      title: 'File',
      attachments: [{ id: crypto.randomUUID(), name: 'a', size: 1, type: 'text/plain' }],
    }),
  ).rejects.toThrow('was not uploaded by this keyed client');
  await expect(herald.send({ title: 'Big', body: '\u4e2d'.repeat(50_000) })).rejects.toThrow(
    'too large to encrypt',
  );
  await herald.send({ title: 'Key', kind: 'secret' }, 'offer-1');
  const body = JSON.parse(seen.at(-1)!.body!);
  expect(body).toMatchObject({ kind: 'secret', asks: false, attachments: [] });
  expect(JSON.stringify(body)).not.toContain('Key');
  expect(body.sealed.ctx).toEqual({ t: 'message', account: keyring.account, id: body.id });
});
it('binds logs and results to the task runner and refuses unsealed task content', async () => {
  const raw = (step('claim-task').response.body as { task: Message }).task;
  const other = await e2ee.keySet();
  const cert = await e2ee.certify(keyring, { sign: other.signPub, box: other.boxPub });
  const keys = {
    ...directory,
    certificates: [...directory.certificates, { integrationId: crypto.randomUUID(), ...cert }],
  };
  const { to } = await owner();
  const by = (payload: e2ee.Payload, ctx: Record<string, string | number> & { t: string }) =>
    e2ee.seal({ payload, ctx: { ...ctx, account: keyring.account }, signer: other, to });
  const forged = await by({ error: 'forged' }, { t: 'result', task: raw.id });
  const log = await by({ text: 'forged' }, { t: 'log', task: raw.id, seq: 0 });
  serve({
    'GET /api/v1/keys': keys,
    [`GET /api/v1/messages/${raw.id}/logs`]: {
      logs: [
        { sequence: 0, stream: 'stdout', text: '', sealed: log },
        { sequence: 1, stream: 'stdout', text: 'plain' },
      ],
    },
    [`GET /api/v1/messages/${raw.id}`]: raw,
  });
  const herald = new Herald({ apiKey: token, url });
  const failed = {
    ...raw,
    result: { status: 'failed', completedAt: raw.createdAt, sealed: forged },
  };
  expect(await herald.openTask(failed as Message)).toMatchObject({ unverified: true });
  const logs = await herald.taskLogs(raw.id);
  expect(logs.map((l) => [l.text, l.unverified])).toEqual([
    ['', true],
    ['', true],
  ]);
  const plain = {
    ...raw,
    input: { ...raw.input!, sealed: undefined, values: { prompt: 'rm -rf' } },
  };
  const opened = await herald.openTask(plain as Message);
  expect(opened).toMatchObject({
    unverified: true,
    input: { values: {} },
    response: { values: {} },
  });
  // Server copies of the session and answer never survive opening.
  const injected = {
    ...raw,
    session: { prompt: 'injected' },
    response: { ...raw.response!, actionId: 'x' },
  };
  const task = await herald.openTask(injected as Message);
  expect(task.session).toBeUndefined();
  expect(task.response!.actionId).toBeUndefined();
});
it('verifies answers against the request and its digest', async () => {
  const herald = new Herald({ apiKey: token, url });
  serve({
    'GET /api/v1/keys': directory,
    [`GET /api/v1/messages/${sent.id}`]: await answered({ approve: 'yes' }),
  });
  expect(await herald.get(sent.id)).toMatchObject({ unverified: true, response: { values: {} } });
  vi.restoreAllMocks();
  const other = (step('send-secret-form').response.body as Message).sealed!;
  serve({
    'GET /api/v1/keys': directory,
    [`GET /api/v1/messages/${sent.id}`]: await answered({ approve: true }, other),
  });
  expect(await herald.get(sent.id)).toMatchObject({ unverified: true, title: 'Encrypted message' });
  vi.restoreAllMocks();
  serve({
    'GET /api/v1/keys': directory,
    'POST /api/v1/messages': sent,
    [`GET /api/v1/messages/${sent.id}`]: await answered({ approve: 'yes' }),
  });
  vi.spyOn(herald.live, 'subscribe').mockReturnValue(() => {});
  await expect(herald.ask({ title: 'Deploy?' })).rejects.toBeInstanceOf(HeraldError);
});
it('opens webhook tasks and refuses downloads without a file key', async () => {
  serve({
    'GET /api/v1/keys': directory,
    'GET /api/v1/files/': new Response('x', {
      headers: { 'Content-Disposition': 'attachment; filename="encrypted"' },
    }),
  });
  const herald = new Herald({ apiKey: token, url });
  const task = (step('claim-task').result as { task: Message }).task;
  const raw = (step('claim-task').response.body as { task: Message }).task;
  expect(await herald.openTask(raw)).toEqual(task);
  await expect(herald.download(crypto.randomUUID())).rejects.toThrow('attachment of an opened');
});
it('trusts no unsealed record, from any connection', async () => {
  const plain = { ...sent, sealed: undefined, senderId: crypto.randomUUID(), title: 'Plain' };
  serve({ 'GET /api/v1/keys': directory, [`GET /api/v1/messages/${sent.id}`]: plain });
  const opened = await new Herald({ apiKey: token, url }).get(sent.id);
  expect(opened).toMatchObject({ unverified: true, title: 'Encrypted message' });
});
it('reveals secret file fields as downloadable attachments, refusing malformed ones', async () => {
  const { signer, to } = await owner();
  const key = e2ee.fileKey();
  const file = { id: crypto.randomUUID(), name: 'id_ed25519', type: 'text/plain', size: 4, key };
  const ctx = (field: string) => ({
    t: 'secret',
    account: keyring.account,
    message: sent.id,
    field,
  });
  const secret = (field: string, payload: object) =>
    e2ee.seal({ payload: { v: 1, ...payload }, ctx: ctx(field), signer, to: [to[1]] });
  const bytes = new Uint8Array(
    await new Response(e2ee.sealFile(key, new Uint8Array(4))).arrayBuffer(),
  );
  serve({
    'GET /api/v1/keys': directory,
    [`POST /api/v1/messages/${sent.id}/secrets`]: {
      token: await secret('token', { value: 'test-only' }),
      cert: await secret('cert', { files: [file] }),
    },
    [`GET /api/v1/files/${file.id}`]: new Response(bytes),
  });
  const herald = new Herald({ apiKey: token, url });
  expect(await herald.revealSecrets(sent.id)).toEqual({ token: 'test-only', cert: [file] });
  expect((await (await herald.download(file.id)).bytes()).length).toBe(4);
  serve({
    'GET /api/v1/keys': directory,
    [`POST /api/v1/messages/${sent.id}/secrets`]: { cert: await secret('cert', { files: [] }) },
  });
  await expect(herald.revealSecrets(sent.id)).rejects.toThrow('Malformed secret');
});
