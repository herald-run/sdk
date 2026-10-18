import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { sealedContracts } from '../fixtures/contracts';
import * as e2ee from './e2ee/index';
import { Herald, HeraldError, version, type KeyDirectory, type Message } from './index';
import { KeyedSession } from './keyed';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
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

it('takes a record team only from a verified envelope or its own send', async () => {
  const keyed = () => new KeyedSession(integration.seed, W.fingerprint, async () => directory);
  const k = keyed();
  const body = await k.sealMessage({ title: 'x' }, 'key-1');
  expect(await k.teamOf(body.id)).toBe('team-ops');
  // A team this connection is not certified for, or an envelope that fails, records nothing.
  for (const bad of [record({ team: 'team-all' }), record({ sealed: response.envelope })]) {
    const s = keyed();
    expect((await s.openRecord(bad)).unverified).toBe(true);
    await expect(s.teamOf(bad.id)).rejects.toThrow('The record has no team');
  }
  // Secret receivers must be members of the record's verified team.
  const { claim, sig } = W.receiver;
  const receiver = {
    claimId: claim.claimId,
    publicKey: claim.publicKey,
    sig,
    member: claim.member,
  };
  const r = keyed();
  expect(await r.checkReceiver(claim.message, receiver, async () => record())).toBe(receiver);
  await expect(
    r.checkReceiver(claim.message, { ...receiver, member: 'user-ben' }, async () => record()),
  ).rejects.toThrow('Not a member of the team');
});

it('reads HERALD_PIN and fails closed on a newer pin', async () => {
  vi.stubEnv('HERALD_PIN', JSON.stringify({ ...W.pin, epoch: 3 }));
  serve({ 'GET /api/v1/keys': directory, 'POST /api/v1/messages': record() });
  await expect(new Herald({ apiKey: token, url }).send({ title: 'x' })).rejects.toThrow(
    'Stale roster epoch',
  );
  vi.stubEnv('HERALD_PIN', '{"workspace":"ws_x"}');
  expect(() => new Herald({ apiKey: token, url })).toThrow('Malformed workspace pin');
});

it('keeps keyring anchors: no root swap, no pin downgrade', async () => {
  const keyring = e2ee.createKeyring('user-ana');
  const anchor = { workspace: W.workspace, fingerprint: W.fingerprint, pin: W.pin };
  const pinned = e2ee.keyringPin(keyring, anchor);
  expect(pinned.workspaces).toEqual([anchor]);
  expect(e2ee.parseWorkspacePin(JSON.stringify(W.pin))).toEqual(W.pin);
  const newer = { ...W.pin, epoch: 3, roster: W.pin.link };
  expect(e2ee.keyringPin(pinned, { ...anchor, pin: newer }).workspaces).toEqual([
    { ...anchor, pin: newer },
  ]);
  expect(e2ee.keyringPin(pinned, { ...anchor, pin: undefined }).workspaces).toEqual([anchor]);
  expect(() => e2ee.keyringPin(e2ee.keyringPin(pinned, { ...anchor, pin: newer }), anchor)).toThrow(
    'Stale roster epoch',
  );
  const other = await e2ee.fingerprint(W.identities[1].signPub);
  expect(() => e2ee.keyringPin(pinned, { ...anchor, fingerprint: other })).toThrow(
    'Workspace fingerprint mismatch',
  );
});

it('re-certifies only certificates verified under the previous roster, teams intersected', async () => {
  const previous = await e2ee.verifyWorkspace({ chain: W.chain, roster: W.roster }, W.fingerprint);
  const head = await e2ee.workspaceIdentity(W.identities[1].seed);
  const r = W.roster.roster;
  const ana = { ...r.members[0], teams: ['team-all'] };
  const next = await e2ee.signRoster(
    { epoch: 3, members: [ana], teams: r.teams, head: W.chain[1] },
    head,
  );
  const current = await e2ee.verifyWorkspace({ chain: W.chain, roster: next }, W.fingerprint);
  // Ana's connection keeps only the teams she had when she certified it, not her new ones.
  const cert = W.certificates[0].certificate;
  const again = await e2ee.recertifyWorkspace(cert, { previous, current, identity: head });
  expect(again.certificate).toMatchObject({ teams: ['team-ops'], epoch: 3 });
  expect(again.certificate.by).toBeUndefined();
  expect((await e2ee.verifyWorkspaceCertificate(again, current)).teams).toEqual(['team-ops']);
  const failing = W.negative.find(
    (c: { name: string }) => c.name === 'member without connect',
  ).certificate;
  await expect(
    e2ee.recertifyWorkspace(failing, { previous, current, identity: head }),
  ).rejects.toThrow('may not connect');
  const old = await e2ee.workspaceIdentity(W.identities[0].seed);
  await expect(e2ee.recertifyWorkspace(cert, { previous, current, identity: old })).rejects.toThrow(
    're-signed by the head',
  );
  await expect(
    e2ee.recertifyWorkspace(cert, { previous: current, current, identity: head }),
  ).rejects.toThrow('Not the previous roster');
});
