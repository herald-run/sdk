import { expect, it, vi } from 'vitest';
import type { Herald } from '@herald-run/sdk';
import { agents, presence, subagents } from './agents';
const io = () => ({ out: vi.fn() });
const fake = (over: Partial<Herald['agents']>) =>
  ({ agents: over }) as unknown as Pick<Herald, 'agents'>;
it('sets presence with text, colour and expiry', async () => {
  const setPresence = vi.fn(async () => ({ expiresAt: 1 }));
  const out = io();
  await presence(
    fake({ setPresence }),
    ['set', 'busy', 'Reviewing'],
    { color: '#112233', ttl: 60 },
    out,
  );
  expect(setPresence).toHaveBeenCalledWith(
    { state: 'busy', text: 'Reviewing', color: '#112233' },
    { ttl: 60 },
  );
  expect(out.out).toHaveBeenCalledWith('busy  Reviewing');
});
it('takes working and error, and still takes busy', async () => {
  const setPresence = vi.fn(async () => ({ expiresAt: 1 }));
  for (const state of ['working', 'error', 'busy'])
    await presence(fake({ setPresence }), ['set', state], {}, io());
  ['working', 'error', 'busy'].forEach((state, n) =>
    expect(setPresence).toHaveBeenNthCalledWith(n + 1, { state }, expect.anything()),
  );
});
it('sets a task and links, and nests a subagent under a parent', async () => {
  const setPresence = vi.fn(async () => ({ expiresAt: 1 }));
  const setSubagent = vi.fn(async () => ({ expiresAt: 1 }));
  const client = fake({ setPresence, setSubagent });
  const link = ['PR=https://example.com/pr?id=1'];
  await presence(client, ['set', 'busy'], { task: 'Reviewing', link }, io());
  expect(setPresence).toHaveBeenCalledWith(
    {
      state: 'busy',
      task: 'Reviewing',
      links: [{ label: 'PR', url: 'https://example.com/pr?id=1' }],
    },
    { ttl: undefined },
  );
  await subagents(client, ['set', 'tests', 'Tests'], { parent: 'review' }, io());
  expect(setSubagent).toHaveBeenCalledWith(
    'tests',
    { state: 'idle', name: 'Tests', parent: 'review' },
    expect.anything(),
  );
  await expect(
    presence(client, ['set', 'busy'], { link: ['https://example.com'] }, io()),
  ).rejects.toThrow('LABEL=URL');
  // A label may hold `=`; the split is at the first `=` before a URL scheme.
  await presence(client, ['set', 'busy'], { link: ['a=b=http://example.com/?x=https://y'] }, io());
  expect(setPresence).toHaveBeenLastCalledWith(
    { state: 'busy', links: [{ label: 'a=b', url: 'http://example.com/?x=https://y' }] },
    { ttl: undefined },
  );
  await expect(presence(client, ['set', 'busy'], { link: ['a=ftp://x'] }, io())).rejects.toThrow(
    'LABEL=URL',
  );
});
it('rejects an unknown state or action', async () => {
  const client = fake({});
  await expect(presence(client, ['set', 'asleep'], {}, io())).rejects.toThrow('State is one of');
  await expect(presence(client, ['get'], {}, io())).rejects.toThrow('Usage');
});
it('manages subagents', async () => {
  const setSubagent = vi.fn(async () => ({ expiresAt: 1 }));
  const removeSubagent = vi.fn(async () => {});
  const list = vi.fn(async () => [{ key: 'review', expiresAt: 9, reach: 'all' as const }]);
  const client = fake({ setSubagent, removeSubagent, subagents: list });
  const out = io();
  await subagents(client, ['set', 'review', 'Reviewer'], { state: 'busy' }, out);
  expect(setSubagent).toHaveBeenCalledWith(
    'review',
    { state: 'busy', name: 'Reviewer' },
    { ttl: undefined, reach: undefined },
  );
  await subagents(client, ['set', 'quiet', 'Q'], { reach: 'agents' }, out);
  expect(setSubagent).toHaveBeenLastCalledWith('quiet', expect.anything(), {
    ttl: undefined,
    reach: 'agents',
  });
  await expect(subagents(client, ['set', 'q', 'Q'], { reach: 'x' }, out)).rejects.toThrow('Reach');
  await subagents(client, ['list'], {}, out);
  expect(out.out).toHaveBeenLastCalledWith('review');
  await subagents(client, ['remove', 'review'], { json: true }, out);
  expect(removeSubagent).toHaveBeenCalledWith('review');
  await expect(subagents(client, ['set', 'x'], {}, out)).rejects.toThrow('Usage');
});
it('registers, lists and unregisters agents', async () => {
  const register = vi.fn(async () => ({ expiresAt: 1 }));
  const unregister = vi.fn(async () => {});
  const list = vi.fn(async () => [{ key: 'lead', expiresAt: 9, reach: 'all' as const }]);
  const client = fake({ register, unregister, list });
  const out = io();
  await agents(
    client,
    ['register', 'lead', 'Lead'],
    { chat: true, parent: 'boss', section: 'Team/Dev', ttl: 60 },
    out,
  );
  expect(register).toHaveBeenCalledWith(
    'lead',
    { state: 'idle', name: 'Lead', parent: 'boss', chat: 'dm', section: ['Team', 'Dev'] },
    { ttl: 60, reach: undefined },
  );
  expect(out.out).toHaveBeenLastCalledWith('lead  Lead');
  await agents(client, ['register', 'q', 'Q'], {}, out);
  expect(register).toHaveBeenLastCalledWith('q', { state: 'idle', name: 'Q' }, expect.anything());
  await agents(client, ['list'], {}, out);
  expect(out.out).toHaveBeenLastCalledWith('lead');
  await agents(client, ['unregister', 'lead'], {}, out);
  expect(unregister).toHaveBeenCalledWith('lead');
  await expect(agents(client, ['register', 'x'], {}, out)).rejects.toThrow('Usage');
});
