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
  expect(herald.keyed).toBe(true);
  const seen = serve({ 'GET /api/v1/keys': directory, 'POST /api/v1/messages': sent });
  await herald.send({ title: 'Hello', body: 'World' });
  expect(seen.map((s) => s.auth)).toEqual(['Bearer hdr_test-only', 'Bearer hdr_test-only']);
  expect(JSON.stringify(seen)).not.toContain(seed);
  expect(JSON.stringify(seen)).not.toContain('World');
  expect(() => new Herald({ apiKey: 'hdr_x.short.fp', url })).toThrow(E2eeError);
  expect(new Herald({ apiKey: 'hdr_legacy', url }).keyed).toBe(false);
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
it('validates input before sealing and keeps secret offers metadata only', async () => {
  const seen = serve({ 'GET /api/v1/keys': directory, 'POST /api/v1/messages': sent });
  const herald = new Herald({ apiKey: token, url });
  await expect(herald.send({ title: '' })).rejects.toMatchObject({ status: 400 });
  await expect(
    herald.send({
      title: 'File',
      attachments: [{ id: crypto.randomUUID(), name: 'a', size: 1, type: 'text/plain' }],
    }),
  ).rejects.toThrow('was not uploaded by this keyed client');
  await herald.send({ title: 'Key', kind: 'secret' });
  expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ title: 'Key', kind: 'secret' });
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
it('opens webhook tasks and refuses encrypted downloads without a key', async () => {
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
  await expect(herald.download(crypto.randomUUID())).rejects.toThrow('end-to-end encrypted');
});
