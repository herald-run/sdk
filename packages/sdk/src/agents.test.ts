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
  await agents.setSubagent('review', { name: 'Reviewer', state: 'busy' }, { ttl: 60 });
  const put = seen.find((s) => s.route.startsWith('PUT'))!.body!;
  expect(put.ttl).toBe(60);
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
