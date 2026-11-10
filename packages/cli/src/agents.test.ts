import { expect, it, vi } from 'vitest';
import type { Herald } from '@herald-run/sdk';
import { presence, subagents } from './agents';
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
