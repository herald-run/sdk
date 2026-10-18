import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { sealedContracts } from '../fixtures/contracts';
import * as e2ee from './e2ee/index';
import { Herald, HeraldError, version, type KeyDirectory, type Message } from './index';
afterEach(() => vi.restoreAllMocks());
// Team workspace behaviour of a keyed client, on the shared workspace vectors.
const V = JSON.parse(
  readFileSync(new URL('../fixtures/e2ee-vectors.json', import.meta.url), 'utf8'),
);
const W = V.workspace;
const integration = V.keySets.find((s: { name: string }) => s.name === 'integration');
const token = e2ee.formatToken('hdr_ws-test', integration.seed, W.fingerprint);
const url = 'https://herald.test';
const directory: KeyDirectory = {
  account: null,
  certificates: W.certificates.map((c: { name: string; certificate: e2ee.Certificate }) => ({
    ...c.certificate,
    integrationId: c.name,
  })),
  workspace: { chain: W.chain, roster: W.roster },
};
const [message, response] = W.envelopes;
const sent = sealedContracts.steps.find((s) => s.name === 'send')!.response.body as Message;
const record = (extra: Partial<Message> = {}): Message => ({
  ...sent,
  id: message.ctx.id,
  team: 'team-ops',
  senderId: 'integration',
  sealed: message.envelope,
  ...extra,
});
type Seen = { route: string; headers: Headers; body?: string };
function serve(routes: Record<string, unknown | (() => unknown)>) {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const route = `${init?.method || 'GET'} ${new URL(String(input)).pathname}`;
    seen.push({
      route,
      headers: new Headers(init?.headers),
      body: init?.body ? String(init.body) : undefined,
    });
    const key = Object.keys(routes).find((r) => route.startsWith(r));
    const value = key && routes[key];
    if (!key) return Response.json({ error: 'Not found.' }, { status: 404 });
    const out = typeof value === 'function' ? value() : value;
    return out instanceof Response ? out : Response.json(out);
  });
  return seen;
}

it('seals to the default team key, sends client headers and stores the pin', async () => {
  const pins: e2ee.WorkspacePin[] = [];
  const herald = new Herald({
    apiKey: token,
    url,
    workspace: W.workspace,
    onPin: (p) => pins.push(p),
  });
  const seen = serve({ 'GET /api/v1/keys': directory, 'POST /api/v1/messages': record() });
  await herald.send({ title: 'Restart?' });
  const body = JSON.parse(seen[1].body!);
  expect(body.team).toBe('team-ops');
  expect(body.sealed.ctx).toMatchObject({ account: W.workspace, team: 'team-ops' });
  expect(body.sealed.to.map((t: { kid: string }) => t.kid)).toEqual([
    W.teams.ops[1],
    integration.kid,
  ]);
  expect(seen[1].headers.get('X-Herald-Client')).toBe(`sdk/${version}`);
  expect(seen[1].headers.get('Herald-Workspace')).toBe(W.workspace);
  expect(pins).toEqual([W.pin]);
  expect(await herald.workspace()).toMatchObject({
    id: W.workspace,
    epoch: 2,
    teams: [{ id: 'team-ops', slug: 'ops' }],
  });
  await expect(herald.send({ title: 'x', team: 'all' })).rejects.toThrow(
    'may not address team all',
  );
  await expect(herald.send({ title: 'x', team: 'nope' })).rejects.toThrow('Unknown team nope');
});

it('reloads the keys and reseals once after a stale team key', async () => {
  let posts = 0;
  const stale = () =>
    ++posts === 1
      ? Response.json({ error: 'Stale.', code: 'E2EE_STALE_KEY' }, { status: 409 })
      : record();
  const seen = serve({ 'GET /api/v1/keys': directory, 'POST /api/v1/messages': stale });
  await new Herald({ apiKey: token, url }).send({ title: 'Restart?' });
  expect(seen.map((s) => s.route)).toEqual([
    'GET /api/v1/keys',
    'POST /api/v1/messages',
    'GET /api/v1/keys',
    'POST /api/v1/messages',
  ]);
  const ids = seen.filter((s) => s.body).map((s) => JSON.parse(s.body!).id);
  expect(new Set(ids).size).toBe(2);
  posts = 0;
  const always = () => Response.json({ error: 'Stale.', code: 'E2EE_STALE_KEY' }, { status: 409 });
  vi.restoreAllMocks();
  serve({ 'GET /api/v1/keys': directory, 'POST /api/v1/messages': always });
  await expect(new Herald({ apiKey: token, url }).send({ title: 'x' })).rejects.toThrow(
    HeraldError,
  );
});

it('reports who answered only from a verified member answer', async () => {
  const answered = record({
    status: 'answered',
    kind: 'form',
    answeredBy: 'user-ben',
    response: {
      values: {},
      secretFields: [],
      createdAt: sent.createdAt,
      sealed: response.envelope,
      by: 'user-ben',
    },
  });
  serve({ 'GET /api/v1/keys': directory, 'GET /api/v1/messages/': answered });
  const herald = new Herald({ apiKey: token, url });
  const got = await herald.get(answered.id);
  expect(got.unverified).toBeUndefined();
  expect([got.answeredBy, got.response?.by, got.response?.actionId]).toEqual([
    'user-ana',
    'user-ana',
    'yes',
  ]);
  // Ben is not in the ops team: his answer is unverified and names nobody.
  const forged = W.negative.find(
    (c: { name: string }) => c.name === 'member outside the team',
  ).envelope;
  vi.restoreAllMocks();
  serve({
    'GET /api/v1/keys': directory,
    'GET /api/v1/messages/': { ...answered, response: { ...answered.response, sealed: forged } },
  });
  const bad = await new Herald({ apiKey: token, url }).get(answered.id);
  expect(bad.unverified).toBe(true);
  expect(bad.answeredBy).toBeUndefined();
  // A record moved to another team no longer matches its envelope.
  vi.restoreAllMocks();
  serve({
    'GET /api/v1/keys': directory,
    'GET /api/v1/messages/': { ...answered, team: 'team-all' },
  });
  expect((await new Herald({ apiKey: token, url }).get(answered.id)).unverified).toBe(true);
});

it('fails closed on rolled-back rosters and personal directories', async () => {
  const cases: [Partial<e2ee.WorkspacePin>, KeyDirectory][] = [
    [{ epoch: 3 }, directory],
    [{}, { ...directory, workspace: undefined }],
  ];
  for (const [change, keys] of cases) {
    serve({ 'GET /api/v1/keys': keys, 'POST /api/v1/messages': record() });
    const herald = new Herald({ apiKey: token, url, pin: { ...W.pin, ...change } });
    await expect(herald.send({ title: 'x' })).rejects.toThrow(e2ee.E2eeError);
    vi.restoreAllMocks();
  }
});
