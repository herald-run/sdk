import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { sealedContracts } from '../fixtures/contracts';
import * as e2ee from './e2ee/index';
import { Fleet, FleetReporter, type ReporterSocket } from './fleet';
import { Herald, HeraldError, type KeyDirectory } from './index';
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const url = 'https://herald.test';
const { token, keyring, steps } = sealedContracts;
const directory = steps.find((s) => s.name === 'keys')!.response.body as KeyDirectory;
const world = {
  id: 'fw_1',
  repo: { id: 1, fullName: 'Acme/App', url: '', defaultBranch: 'main', private: true },
  createdAt: '2026-01-01T00:00:00.000Z',
};
type Seen = { route: string; body?: string };
function serve(routes: Record<string, unknown | (() => unknown)>, keys: unknown = directory) {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const target = new URL(String(input));
    const route = `${init?.method || 'GET'} ${target.pathname}`;
    seen.push({ route, body: init?.body ? String(init.body) : undefined });
    if (route === 'GET /api/v1/keys') return Response.json(keys);
    const value = routes[route];
    if (value === undefined) return Response.json({ error: 'Not found.' }, { status: 404 });
    const out = typeof value === 'function' ? value() : value;
    return out instanceof Response ? out : Response.json(out);
  });
  return seen;
}
const state = {
  name: 'app (main)',
  kind: 'claude-code',
  activity: 'editing' as const,
  files: ['src/a.ts'],
};
const posted = (seen: Seen[]) =>
  JSON.parse(seen.find((s) => s.route.startsWith('POST'))!.body!) as {
    units: { key: string; ttl: number; sealed: e2ee.SealedEnvelope }[];
  };

it('seals units bound to account, world and key, readable by the account', async () => {
  const seen = serve({
    'POST /api/v1/fleet/worlds/fw_1/units': { units: [{ key: 'k1', expiresAt: 'x' }] },
  });
  const herald = new Herald({ apiKey: token, url });
  await herald.fleet.report('fw_1', [{ key: 'k1', state }]);
  const [unit] = posted(seen).units;
  expect(unit).toMatchObject({ key: 'k1', ttl: 600 });
  expect(unit.sealed.ctx).toEqual({
    t: 'fleet-unit',
    account: keyring.account,
    world: 'fw_1',
    key: 'k1',
  });
  const owner = await e2ee.keyringKeys(keyring);
  const me = await e2ee.keySet(e2ee.parseToken(token).seed);
  expect(unit.sealed.to.map((r) => r.kid)).toEqual([owner.inboxKid, me.kid]);
  const opened = await e2ee.open(unit.sealed, {
    recipients: [owner.inbox[0]],
    signers: (kid) => (kid === me.kid ? me.signPub : undefined),
    expect: { t: 'fleet-unit', account: keyring.account, world: 'fw_1', key: 'k1' },
  });
  expect(opened).toMatchObject({ ...state, v: 1 });
  // Another world or key does not open it.
  await expect(
    e2ee.open(unit.sealed, {
      recipients: [owner.inbox[0]],
      signers: () => me.signPub,
      expect: { t: 'fleet-unit', account: keyring.account, world: 'fw_2', key: 'k1' },
    }),
  ).rejects.toThrow();
});

it('seals to the default team key in a team workspace', async () => {
  const V = JSON.parse(
    readFileSync(new URL('../fixtures/e2ee-vectors.json', import.meta.url), 'utf8'),
  );
  const W = V.workspace;
  const integration = V.keySets.find((s: { name: string }) => s.name === 'integration');
  const teamToken = e2ee.formatToken('hdr_ws-test', integration.seed, W.fingerprint);
  const teamDirectory = {
    account: null,
    certificates: W.certificates.map((c: { name: string; certificate: e2ee.Certificate }) => ({
      ...c.certificate,
      integrationId: c.name,
    })),
    workspace: { chain: W.chain, roster: W.roster },
  };
  const seen = serve({ 'POST /api/v1/fleet/worlds/fw_1/units': { units: [] } }, teamDirectory);
  await new Herald({ apiKey: teamToken, url, workspace: W.workspace }).fleet.report('fw_1', [
    { key: 'k1', state },
  ]);
  const [unit] = posted(seen).units;
  expect(unit.sealed.ctx).toEqual({
    t: 'fleet-unit',
    account: W.workspace,
    world: 'fw_1',
    key: 'k1',
    team: 'team-ops',
  });
  expect(unit.sealed.to.map((r) => r.kid)).toEqual([W.teams.ops[1], integration.kid]);
});

it('validates states, keys, batches and the envelope cap before sending', async () => {
  const seen = serve({});
  const fleet = new Herald({ apiKey: token, url }).fleet;
  await expect(fleet.report('fw_1', [{ key: 'bad key', state }])).rejects.toThrow('Unit keys');
  await expect(fleet.report('fw_1', [{ key: 'k', state: { ...state, name: '' } }])).rejects.toThrow(
    HeraldError,
  );
  await expect(
    fleet.report('fw_1', [
      { key: 'k', state },
      { key: 'k', state },
    ]),
  ).rejects.toThrow('unique');
  await expect(fleet.report('fw_1', [])).rejects.toThrow('1 to 50');
  await expect(fleet.report('fw_1', [{ key: 'k', ttl: 5, state }])).rejects.toThrow(HeraldError);
  const files = Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(300, 'é'));
  await expect(fleet.report('fw_1', [{ key: 'k', state: { ...state, files } }])).rejects.toThrow(
    'exceeds 6,000 characters',
  );
  expect(seen.filter((s) => s.route.startsWith('POST'))).toEqual([]);
  // Unknown kinds and activities fall back as viewers would read them.
  const [unit] = await fleet.units('fw_1', [{ key: 'k', state: { name: 'x', kind: 'Bad!' } }]);
  expect(unit.ttl).toBe(600);
});

it('lists and resolves worlds, removes units, tracks refs and surfaces quota pauses', async () => {
  const paused = { error: 'Used up.', code: 'FLEET_QUOTA', resetsAt: '2026-02-01T00:00:00.000Z' };
  const seen = serve({
    'GET /api/v1/fleet': { worlds: [world] },
    'DELETE /api/v1/fleet/worlds/fw_1/units/k1': () => new Response(null, { status: 204 }),
    'PUT /api/v1/fleet/worlds/fw_1/refs': () => Response.json({ ok: true }, { status: 202 }),
    'POST /api/v1/fleet/worlds/fw_1/units': () =>
      Response.json(paused, { status: 429, headers: { 'Retry-After': '86400' } }),
  });
  const fleet = new Herald({ apiKey: token, url }).fleet;
  expect(await fleet.worlds()).toEqual([world]);
  expect(await fleet.world('acme/app')).toEqual(world);
  expect(await fleet.world('fw_1')).toEqual(world);
  expect(await fleet.world('acme/other')).toBeUndefined();
  await fleet.remove('fw_1', 'k1');
  await fleet.track('fw_1', 'feature/x');
  expect(JSON.parse(seen.find((s) => s.route.startsWith('PUT'))!.body!)).toEqual({
    ref: 'feature/x',
  });
  await expect(fleet.track('fw_1', '')).rejects.toThrow(HeraldError);
  const error = await fleet.report('fw_1', [{ key: 'k1', state }]).catch((e: unknown) => e);
  expect(error).toMatchObject({ status: 429, code: 'FLEET_QUOTA', resetsAt: paused.resetsAt });
});

/** A fake `ws` socket: emits events on demand and records sent frames. */
function fakeSocket() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const socket = {
    sent: [] as string[],
    closed: false,
    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(listener);
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners[event] || []) l(...args);
    },
    send(data: string) {
      socket.sent.push(data);
    },
    close() {
      socket.closed = true;
    },
  };
  return socket;
}
const sealer = async (units: { key: string; ttl?: number }[]) =>
  units.map((u) => ({ key: u.key, ttl: u.ttl ?? 600, sealed: {} as e2ee.SealedEnvelope }));

it('reporter sends frames while open, within the frame budget, and surfaces error frames', async () => {
  vi.useFakeTimers();
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const errors: unknown[] = [];
  let syncs = 0;
  const reporter = new FleetReporter(
    () => {
      sockets.push(fakeSocket());
      return sockets.at(-1)! as unknown as ReporterSocket;
    },
    sealer,
    {
      framesPerMinute: 2,
      delay: () => 1000,
      onError: (e) => errors.push(e),
      onSync: () => syncs++,
    },
  );
  const unit = { key: 'k1', state };
  expect(await reporter.send([unit])).toBe(false);
  sockets[0].emit('open');
  expect(await reporter.send([unit], { persist: false })).toBe(true);
  expect(JSON.parse(sockets[0].sent[0])).toEqual({
    type: 'units',
    units: [{ key: 'k1', ttl: 600, sealed: {} }],
    persist: false,
  });
  expect(await reporter.send([unit])).toBe(true);
  expect(await reporter.send([unit])).toBe(false);
  vi.advanceTimersByTime(60_000);
  expect(reporter.budget).toBe(2);
  sockets[0].emit(
    'message',
    JSON.stringify({ type: 'error', error: 'Paused.', code: 'FLEET_QUOTA' }),
  );
  sockets[0].emit(
    'message',
    JSON.stringify({ type: 'error', error: 'Slow.', code: 'FLEET_RATE', retryAfter: 4 }),
  );
  sockets[0].emit('message', 'not json');
  sockets[0].emit('message', JSON.stringify({ type: 'sync' }));
  expect(syncs).toBe(1);
  expect(errors).toEqual([
    { error: 'Paused.', code: 'FLEET_QUOTA' },
    { error: 'Slow.', code: 'FLEET_RATE', retryAfter: 4 },
  ]);
  // A dropped socket reconnects after the backoff delay; close() stops it.
  sockets[0].emit('close', 1008, 'Too many messages');
  expect(reporter.connected).toBe(false);
  vi.advanceTimersByTime(1000);
  expect(sockets).toHaveLength(2);
  reporter.close();
  expect(sockets[1].closed).toBe(true);
  sockets[1].emit('close', 1000, '');
  vi.advanceTimersByTime(60_000);
  expect(sockets).toHaveLength(2);
});

it('reporter connects to the world path and reloads keys after a stale team key', async () => {
  const socket = fakeSocket();
  const refresh = vi.fn(async () => {});
  const errors: unknown[] = [];
  const paths: string[] = [];
  const fleet = new Fleet({
    request: async () => ({}) as never,
    seal: async () => ({}) as e2ee.SealedEnvelope,
    sealed: (post) => post(),
    refresh,
    connect: (path) => (paths.push(path), socket as unknown as ReporterSocket),
  });
  const reporter = fleet.reporter('fw 1', { onError: (e) => errors.push(e) });
  expect(paths).toEqual(['/fleet/ws?world=fw%201']);
  socket.emit(
    'message',
    JSON.stringify({ type: 'error', error: 'Stale.', code: 'E2EE_STALE_KEY' }),
  );
  expect(refresh).toHaveBeenCalledOnce();
  expect(errors).toEqual([{ error: 'Stale.', code: 'E2EE_STALE_KEY' }]);
  reporter.close();
});

it('seals and opens fleet-unit envelopes with personal and team contexts', async () => {
  type Ctx = { t: string; account: string } & Record<string, string>;
  const me = await e2ee.keySet();
  const to = [{ kid: me.kid, box: me.boxPub }];
  const contexts: Ctx[] = [
    { t: 'fleet-unit', account: 'acct', world: 'fw_1', key: 'k1' },
    { t: 'fleet-unit', account: 'ws_1', world: 'fw_1', key: 'k1', team: 'team-ops' },
  ];
  for (const ctx of contexts) {
    const env = await e2ee.seal({ payload: { name: 'x' }, ctx, signer: me, to });
    const opened = await e2ee.open(env, {
      recipients: [me],
      signers: () => me.signPub,
      expect: ctx,
    });
    expect(opened).toMatchObject({ name: 'x' });
  }
  // Workspace fields are required in a team workspace and forbidden elsewhere.
  const bad: Ctx[] = [
    { t: 'fleet-unit', account: 'acct', world: 'fw_1', key: 'k1', team: 't' },
    { t: 'fleet-unit', account: 'ws_1', world: 'fw_1', key: 'k1' },
    { t: 'fleet-unit', account: 'acct', world: 'fw_1' },
  ];
  for (const ctx of bad)
    await expect(e2ee.seal({ payload: {}, ctx, signer: me, to })).rejects.toThrow();
});
