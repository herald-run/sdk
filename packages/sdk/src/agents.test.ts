import { afterEach, expect, it, vi } from 'vitest';
import { sealedContracts } from '../fixtures/contracts';
import * as e2ee from './e2ee/index';
import { Herald, type KeyDirectory } from './index';
afterEach(() => vi.restoreAllMocks());
const { token, keyring, steps } = sealedContracts;
const directory = steps.find((s) => s.name === 'keys')!.response.body as KeyDirectory;
const url = 'https://herald.test';
const runner = directory.certificates[0];
const human = 'h:' + keyring.account;
const agent = 'a:' + runner.integrationId;
async function ownerKeys(): Promise<e2ee.ChatKeys> {
  const k = await e2ee.keyringKeys(keyring);
  const inbox = { kid: k.inboxKid, box: k.inbox[0].boxPub };
  return {
    account: keyring.account,
    principal: human,
    signer: { kid: k.signerKid, signPriv: k.identity.signPriv },
    openers: [{ kid: k.inboxKid, boxPub: k.inbox[0].boxPub, boxPriv: k.inbox[0].boxPriv }],
    recipient: (p) =>
      p === human
        ? inbox
        : p === agent
          ? { kid: runner.certificate.kid, box: runner.certificate.box }
          : undefined,
    verifier: (p) =>
      p === human
        ? { kid: k.signerKid, sign: k.identity.signPub }
        : p === agent
          ? { kid: runner.certificate.kid, sign: runner.certificate.sign }
          : undefined,
  };
}
type Reply = unknown | (() => unknown);
function serve(routes: Record<string, Reply>) {
  const seen: { route: string; body?: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = new URL(String(input));
    const route = `${init?.method || 'GET'} ${u.pathname}`;
    seen.push({ route, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((r) => route.startsWith(r));
    if (!key) return Response.json({ error: 'Not found.' }, { status: 404 });
    const value = routes[key];
    const out = typeof value === 'function' ? (value as () => unknown)() : value;
    return out instanceof Response ? out : Response.json(out);
  });
  return seen;
}
const keysRoute = { 'GET /api/v1/keys': directory };
const client = () => new Herald({ apiKey: token, url }).agents;
it('seals presence to the owner alone and sends only changes', async () => {
  const seen = serve({ ...keysRoute, 'PUT /api/v1/agents/me/presence': { expiresAt: 5 } });
  const agents = client();
  await agents.setPresence({ state: 'busy', color: '#aa00ff', text: 'Reviewing' });
  const puts = () => seen.filter((s) => s.route.startsWith('PUT'));
  const first = puts()[0].body!;
  expect(JSON.stringify(first)).not.toContain('Reviewing');
  const env = first.envelope as e2ee.SealedEnvelope;
  expect(env.to).toHaveLength(1);
  expect(env.ctx).toEqual({ t: 'presence', account: keyring.account, principal: agent });
  const owner = await ownerKeys();
  expect(await e2ee.openPresence(owner, agent, env)).toMatchObject({
    state: 'busy',
    text: 'Reviewing',
  });
  // The same state inside half its lifetime sends nothing; a change does.
  await agents.setPresence({ state: 'busy', color: '#aa00ff', text: 'Reviewing' });
  expect(puts()).toHaveLength(1);
  await agents.setPresence({ state: 'idle' });
  expect(puts()).toHaveLength(2);
  // Past half its lifetime an unchanged state only touches the expiry.
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 200_000);
  await agents.setPresence({ state: 'idle' });
  expect(puts()[2].body).toEqual({ ttl: 300 });
});
it('refuses presence a server swapped to another connection or state', async () => {
  const seen = serve({ ...keysRoute, 'PUT /api/v1/agents/me/presence': { expiresAt: 5 } });
  await client().setPresence({ state: 'blocked' });
  const env = seen.find((s) => s.route.startsWith('PUT'))!.body!.envelope as e2ee.SealedEnvelope;
  const owner = await ownerKeys();
  await expect(e2ee.openPresence(owner, 'a:other', env)).rejects.toThrow();
  await expect(
    e2ee.openPresence(owner, agent, { ...env, ctx: { ...env.ctx, principal: 'a:other' } }),
  ).rejects.toThrow();
  await expect(client().setPresence({ state: 'asleep' as never })).rejects.toThrow('state');
});
it('seals a subagent name under its key and lists or removes them', async () => {
  const seen = serve({
    ...keysRoute,
    'PUT /api/v1/agents/me/subagents/review': { expiresAt: 5 },
    'GET /api/v1/agents/me/subagents': { subagents: [{ key: 'review', expiresAt: 5 }] },
    'DELETE /api/v1/agents/me/subagents/review': {},
  });
  const agents = client();
  await agents.setSubagent(
    'review',
    { name: 'Reviewer', state: 'busy' },
    { ttl: 60, reach: 'agents' },
  );
  const put = seen.find((s) => s.route.startsWith('PUT'))!.body!;
  expect(put).toMatchObject({ ttl: 60, reach: 'agents' });
  await agents.renewSubagent('review', { reach: 'all' });
  expect(seen.at(-1)!.body).toEqual({ ttl: 300, reach: 'all' });
  expect(JSON.stringify(put)).not.toContain('Reviewer');
  const env = put.envelope as e2ee.SealedEnvelope;
  const owner = await ownerKeys();
  expect(await e2ee.openSubagent(owner, agent, 'review', env)).toMatchObject({ name: 'Reviewer' });
  await expect(e2ee.openSubagent(owner, agent, 'other', env)).rejects.toThrow();
  await expect(agents.setSubagent('bad key', { name: 'x', state: 'idle' })).rejects.toThrow('key');
  await expect(agents.setSubagent('a', { name: ' ', state: 'idle' })).rejects.toThrow('name');
  expect(await agents.subagents()).toEqual([{ key: 'review', expiresAt: 5 }]);
  await agents.removeSubagent('review');
  expect(seen.at(-1)!.route).toBe('DELETE /api/v1/agents/me/subagents/review');
});
it('seals task, links and a parent, and refuses bad ones', async () => {
  const seen = serve({ ...keysRoute, 'PUT /api/v1/agents/me/': { expiresAt: 5 } });
  const agents = client();
  const links = [{ label: 'Pull request', url: 'https://example.com/pr/1' }];
  await agents.setPresence({ state: 'busy', task: 'Fixing the login bug', links });
  await agents.setSubagent('tests', { name: 'Tests', state: 'busy', parent: 'review' });
  const [presence, sub] = seen.filter((s) => s.route.startsWith('PUT')).map((s) => s.body!);
  const owner = await ownerKeys();
  const env = (body: Record<string, unknown>) => body.envelope as e2ee.SealedEnvelope;
  expect(await e2ee.openPresence(owner, agent, env(presence))).toMatchObject({
    task: 'Fixing the login bug',
    links,
  });
  expect(await e2ee.openSubagent(owner, agent, 'tests', env(sub))).toMatchObject({
    parent: 'review',
  });
  const bad = (presence: Partial<e2ee.AgentPresence>) =>
    agents.setPresence({ state: 'idle', ...presence });
  await expect(bad({ task: 'x'.repeat(201) })).rejects.toThrow('task');
  await expect(
    bad({ links: [links[0], { label: 'a', url: 'javascript:alert(1)' }] }),
  ).rejects.toThrow('Invalid presence link 2: the URL must be http or https');
  await expect(bad({ links: [{ label: ' ', url: 'https://example.com' }] })).rejects.toThrow(
    'Invalid presence link 1: a label of 1 to 60 characters',
  );
  await expect(bad({ links: [links[0], links[0]] })).rejects.toThrow(
    'Invalid presence link 2: duplicate URL',
  );
  await expect(
    bad({ links: [{ label: 'a', url: 'https://user:pass@example.com/x' }] }),
  ).rejects.toThrow('Invalid presence link 1: the URL must not contain credentials');
  await expect(bad({ links: Array(9).fill(links[0]) })).rejects.toThrow('links');
  const sub2 = (parent: string) =>
    agents.setSubagent('tests', { name: 'T', state: 'idle', parent });
  await expect(sub2('tests')).rejects.toThrow('parent');
  await expect(sub2('bad key')).rejects.toThrow('parent');
});
it('registers agents with entry fields, refuses bad ones and keeps names', async () => {
  const seen = serve({
    ...keysRoute,
    'PUT /api/v1/agents/me/': { expiresAt: 5 },
    'DELETE /api/v1/agents/me/': {},
    'GET /api/v1/agents/me/subagents': { subagents: [{ key: 'lead', expiresAt: 5, reach: 'all' }] },
    'PUT /api/v1/chats/room_1/agents/lead': { id: 'room_1' },
  });
  const agents = client();
  const entry = {
    section: ['Team', 'Leads'],
    order: 2,
    chat: { room: 'room_1' },
    room: 'room_1',
    requests: true,
    about: 'Leads one task.',
  };
  await agents.register('lead', { name: 'Lead', state: 'busy', ...entry }, { reach: 'all' });
  const put = seen.find((s) => s.route === 'PUT /api/v1/agents/me/subagents/lead')!;
  expect(put.body).toMatchObject({ ttl: 300, reach: 'all' });
  const owner = await ownerKeys();
  const env = put.body!.envelope as e2ee.SealedEnvelope;
  expect(await e2ee.openSubagent(owner, agent, 'lead', env)).toMatchObject(entry);
  // Its room is joined once, not on every update.
  expect(seen.at(-1)!.route).toBe('PUT /api/v1/chats/room_1/agents/lead');
  await agents.register('lead', { name: 'Lead', state: 'idle', ...entry });
  expect(seen.filter((s) => s.route.includes('/chats/'))).toHaveLength(1);
  await agents.renew('lead', { ttl: 60 });
  expect(seen.at(-1)).toEqual({ route: 'PUT /api/v1/agents/me/subagents/lead', body: { ttl: 60 } });
  expect(await agents.list()).toEqual([{ key: 'lead', expiresAt: 5, reach: 'all' }]);
  await agents.unregister('lead');
  expect(seen.at(-1)!.route).toBe('DELETE /api/v1/agents/me/subagents/lead');
  expect(agents.agentName('lead')).toBe('Lead');
  // Registered again, it rejoins its room.
  await agents.register('lead', { name: 'Lead', state: 'busy', ...entry });
  expect(seen.filter((s) => s.route.includes('/chats/'))).toHaveLength(2);
  // The old names still work.
  await agents.setSubagent('old', { name: 'Old', state: 'idle' });
  await agents.renewSubagent('old');
  await agents.removeSubagent('old');
  expect(await agents.subagents()).toHaveLength(1);
  expect(agents.subagentName('old')).toBe('Old');
  await expect(agents.register('bad key', { name: 'X', state: 'idle' })).rejects.toThrow('key');
  const bad = (presence: Partial<e2ee.AgentPresence>) =>
    agents.register('lead', { name: 'Lead', state: 'idle', ...presence });
  await expect(bad({ section: [] })).rejects.toThrow('section');
  await expect(bad({ section: [' '] })).rejects.toThrow('section');
  await expect(bad({ section: ['x'.repeat(61)] })).rejects.toThrow('section');
  await expect(bad({ section: ['a', 'b', 'c', 'd', 'e'] })).rejects.toThrow('section');
  await expect(bad({ section: 'Team' as never })).rejects.toThrow('section');
  await expect(bad({ order: Infinity })).rejects.toThrow('order');
  await expect(bad({ chat: 'room' as never })).rejects.toThrow('chat');
  await expect(bad({ chat: { room: 'a b' } })).rejects.toThrow('chat');
  await expect(bad({ room: 'a b' })).rejects.toThrow('room');
  await expect(bad({ requests: 'yes' as never })).rejects.toThrow('requests');
  await expect(bad({ about: 'x'.repeat(501) })).rejects.toThrow('about');
});
it('opens entry fields tolerantly', async () => {
  const { owner, env } = await raw('presence', {
    state: 'idle',
    section: ['ok', ''],
    order: 'first',
    chat: { room: 'ok', extra: 1 },
    room: 'a b',
    requests: 1,
    about: 'x'.repeat(501),
  });
  const opened = await e2ee.openPresence(owner, human, env);
  expect(opened).toMatchObject({ state: 'idle', chat: { room: 'ok' } });
  expect(Object.keys(opened)).not.toContain('section');
  for (const k of ['order', 'requests', 'about', 'room']) expect(opened).not.toHaveProperty(k);
  expect(opened.chat).toEqual({ room: 'ok' });
});
/** The owner seals raw content as if it came from the connection `human`, to test opening. */
async function raw(t: 'presence' | 'subagent', payload: unknown, key = 'tests') {
  const owner = await ownerKeys();
  const ctx =
    t === 'presence'
      ? e2ee.presenceContext(keyring.account, human)
      : e2ee.subagentContext(keyring.account, human, key);
  const env = await e2ee.seal({
    payload: payload as e2ee.Payload,
    ctx,
    signer: owner.signer,
    to: [owner.recipient(human)!],
  });
  return { owner, env };
}
it('opens presence tolerantly: an invalid optional field is dropped, not the presence', async () => {
  const link = (n: number) => ({ label: `L${n}`, url: `https://example.com/${n}` });
  const many = Array.from({ length: 12 }, (_, n) => link(n));
  const open = async (extra: object) => {
    const { owner, env } = await raw('presence', { state: 'busy', text: 'Hi', ...extra });
    return e2ee.openPresence(owner, human, env);
  };
  const dropped = await open({ task: 'x'.repeat(201), links: 'nope' });
  expect(dropped).toMatchObject({ state: 'busy', text: 'Hi' });
  expect(dropped).not.toHaveProperty('task');
  expect(dropped).not.toHaveProperty('links');
  expect(await open({ task: 5 })).not.toHaveProperty('task');
  const bad = [
    { label: ' ', url: 'https://example.com/a' },
    { label: 'js', url: 'javascript:alert(1)' },
    { label: 'cred', url: 'https://user:pass@example.com/x' },
    null,
    { label: 'L1', url: 'https://example.com/1' },
    { label: 'again', url: 'https://example.com/1' },
  ];
  // Invalid and repeated links are dropped, then the first 8 remain.
  const kept = (await open({ task: 'ok', links: [...bad, ...many] })).links;
  expect(kept?.map((l) => l.url.at(-1))).toEqual(['1', '0', '2', '3', '4', '5', '6', '7']);
  expect((await open({ links: bad })).links).toEqual([link(1)]);
  expect(await open({ task: 'ok' })).toMatchObject({ task: 'ok' });
  await expect(open({ state: 'asleep' })).rejects.toThrow('state');
});
it('opens a subagent tolerantly: a bad or own-key parent shows it at the top level', async () => {
  const open = async (parent: unknown, key = 'tests') => {
    const { owner, env } = await raw('subagent', { state: 'idle', name: 'T', parent }, key);
    return e2ee.openSubagent(owner, human, key, env);
  };
  expect(await open('review')).toMatchObject({ parent: 'review' });
  for (const parent of ['bad key', 'tests', 7, 'x'.repeat(65)])
    expect(await open(parent)).not.toHaveProperty('parent');
  const { owner, env } = await raw('subagent', { state: 'idle', name: '' });
  await expect(e2ee.openSubagent(owner, human, 'tests', env)).rejects.toThrow('name');
});
it('seals a layout to its member and rejects one for another member', async () => {
  const owner = await ownerKeys();
  const layout = {
    groups: [{ id: 'g1', name: 'Research' }],
    places: { [agent]: { group: 'g1' } },
  };
  const env = await e2ee.sealLayout(owner, layout);
  expect(env.to).toHaveLength(1);
  expect(await e2ee.openLayout(owner, env)).toMatchObject(layout);
  await expect(
    e2ee.openLayout(owner, { ...env, ctx: { ...env.ctx, principal: 'h:other' } }),
  ).rejects.toThrow();
});
