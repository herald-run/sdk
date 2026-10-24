import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import type { FleetFrameError } from '@herald-run/sdk';
import { FleetDaemon, readLines, serveDaemon, type DaemonFleet } from './daemon';
import { toDaemon } from './protocol';
const world = {
  id: 'fw_1',
  repo: { id: 1, fullName: 'acme/app', url: '', defaultBranch: 'main', private: true },
  createdAt: '',
};
type Frame = { keys: string[]; persist: boolean; activity: (string | undefined)[] };
/** A fake fleet whose reporter records frames; `connected` toggles the socket. */
function fake() {
  const frames: Frame[] = [];
  const state = {
    connected: true,
    onError: undefined as ((e: FleetFrameError) => void) | undefined,
  };
  const fleet = {
    worlds: vi.fn(async () => [world]),
    remove: vi.fn(async () => {}),
    track: vi.fn(async () => {}),
    reporter: vi.fn((_id: string, options) => {
      state.onError = options?.onError;
      return {
        send: async (units: { key: string; state: { activity?: string } }[], o = {}) => {
          if (!state.connected) return false;
          frames.push({
            keys: units.map((u) => u.key),
            persist: (o as { persist?: boolean }).persist ?? true,
            activity: units.map((u) => u.state.activity),
          });
          return true;
        },
        close: vi.fn(),
      };
    }),
  } satisfies DaemonFleet;
  return { fleet, frames, state };
}
const unit = (key: string, state: object, ttl?: number, pushed?: true) => ({
  repo: 'acme/app',
  key,
  ...(ttl ? { ttl } : {}),
  ...(pushed ? { pushed } : {}),
  state: { name: key, ...state },
});

it('coalesces updates per unit and sends each at most every 2 s', async () => {
  let now = 0;
  const { fleet, frames } = fake();
  const daemon = new FleetDaemon(fleet, { now: () => now });
  daemon.update(unit('a', { activity: 'reading' }));
  daemon.update(unit('a', { activity: 'editing' }));
  daemon.update(unit('b', { activity: 'running' }));
  await daemon.tick();
  expect(frames).toEqual([{ keys: ['a', 'b'], persist: true, activity: ['editing', 'running'] }]);
  now = 1000;
  daemon.update(unit('a', { activity: 'reading' }));
  daemon.update(unit('a', { activity: 'editing' }));
  await daemon.tick();
  expect(frames).toHaveLength(1);
  now = 2000;
  await daemon.tick();
  // Same ref, area and activity: shown live, not stored.
  expect(frames[1]).toEqual({ keys: ['a'], persist: false, activity: ['editing'] });
  expect(fleet.worlds).toHaveBeenCalledTimes(1);
  expect(fleet.reporter).toHaveBeenCalledTimes(1);
});

it('stores on ref, area or activity changes and at least every 60 s; re-sends before the TTL', async () => {
  let now = 0;
  const { fleet, frames } = fake();
  const daemon = new FleetDaemon(fleet, { now: () => now });
  daemon.update(unit('a', { activity: 'running', area: 'src' }, 40));
  await daemon.tick();
  for (const [at, change, persist] of [
    [3000, { area: 'docs' }, true],
    [6000, { files: ['x'] }, false],
    [9000, { ref: 'feature' }, true],
  ] as const) {
    now = at;
    daemon.update(unit('a', change, undefined, 'ref' in change || undefined));
    await daemon.tick();
    expect(frames.at(-1)?.persist, JSON.stringify(change)).toBe(persist);
  }
  expect(fleet.track).toHaveBeenCalledExactlyOnceWith('fw_1', 'feature');
  // Without updates an active unit is re-sent at 75% of its 40 s TTL…
  const count = frames.length;
  now = 9000 + 29_000;
  await daemon.tick();
  expect(frames).toHaveLength(count);
  now = 9000 + 30_000;
  await daemon.tick();
  expect(frames.at(-1)).toMatchObject({ keys: ['a'], persist: false });
  // …and stored once 60 s passed since the last store.
  now = 9000 + 60_000;
  await daemon.tick();
  expect(frames.at(-1)).toMatchObject({ keys: ['a'], persist: true });
  // Idle units are sent once and left to fade.
  now += 2000;
  daemon.update(unit('a', { activity: 'idle' }));
  await daemon.tick();
  const idle = frames.length;
  now += 600_000;
  await daemon.tick();
  expect(frames).toHaveLength(idle);
});

it('tracks only refs on the remote', async () => {
  const { fleet } = fake();
  const daemon = new FleetDaemon(fleet);
  daemon.update(unit('a', { ref: 'local' }));
  await daemon.tick();
  expect(fleet.track).not.toHaveBeenCalled();
});

it('keeps units dirty while the socket is down and stops re-sending stale units', async () => {
  let now = 0;
  const { fleet, frames, state } = fake();
  const daemon = new FleetDaemon(fleet, { now: () => now, staleAfter: 100_000 });
  state.connected = false;
  daemon.update(unit('a', { activity: 'running' }));
  await daemon.tick();
  expect(frames).toEqual([]);
  state.connected = true;
  now = 500;
  await daemon.tick();
  expect(frames).toHaveLength(1);
  now = 200_000;
  await daemon.tick();
  expect(frames).toHaveLength(1);
  expect(daemon.units).toBe(0);
});

it('pauses a world until a quota resets and resends after refused frames', async () => {
  let now = 0;
  const { fleet, frames, state } = fake();
  const log = vi.fn();
  const daemon = new FleetDaemon(fleet, { now: () => now, log });
  daemon.update(unit('a', { activity: 'running' }));
  await daemon.tick();
  const resetsAt = new Date(1_000_000).toISOString();
  state.onError!({ error: 'Used up.', code: 'FLEET_QUOTA', resetsAt });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('paused until'));
  now = 999_000;
  daemon.update(unit('a', { activity: 'editing' }));
  await daemon.tick();
  expect(frames).toHaveLength(1);
  now = 1_000_000;
  await daemon.tick();
  expect(frames.at(-1)).toMatchObject({ keys: ['a'], persist: true });
  // Other refusals pause for a minute; a stale team key resends at once, stored.
  state.onError!({ error: 'Too many units.', code: 'FLEET_LIMIT' });
  now += 30_000;
  await daemon.tick();
  expect(frames).toHaveLength(2);
  now += 31_000;
  await daemon.tick();
  expect(frames).toHaveLength(3);
  // A rate limit pauses for its retryAfter.
  state.onError!({ error: 'Slow down.', code: 'FLEET_RATE', retryAfter: 5 });
  now += 4000;
  await daemon.tick();
  expect(frames).toHaveLength(3);
  now += 1000;
  await daemon.tick();
  expect(frames).toHaveLength(4);
  state.onError!({ error: 'Stale.', code: 'E2EE_STALE_KEY' });
  now += 2000;
  await daemon.tick();
  expect(frames.at(-1)).toMatchObject({ persist: true });
});

it('removes units, skips repos without a world and reads JSON lines', async () => {
  const { fleet, frames } = fake();
  const log = vi.fn();
  const daemon = new FleetDaemon(fleet, { log });
  daemon.update(unit('a', { activity: 'running' }));
  daemon.update({ repo: 'acme/app', key: 'a', remove: true });
  daemon.update({ ...unit('b', {}), repo: 'acme/other' });
  await daemon.tick();
  expect(fleet.remove).toHaveBeenCalledWith('fw_1', 'a', { retry: false });
  expect(frames).toEqual([]);
  expect(log).toHaveBeenCalledWith('No Fleet world for acme/other; add it in Herald.');
  const socket = new PassThrough();
  const update = vi.fn();
  readLines(socket as unknown as Socket, { update });
  socket.write(JSON.stringify(unit('c', {})) + '\nnot json\n{"repo":"x"}\n');
  socket.write(JSON.stringify(unit('d', {})).slice(0, 10));
  await new Promise((resolve) => setImmediate(resolve));
  expect(update.mock.calls.map(([u]) => u.key)).toEqual(['c']);
});

it('serves a private unix socket, refuses a second daemon and stops on abort', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'herald-fleet-'));
  const path = join(dir, 'herald-fleet.sock');
  const { fleet } = fake();
  const daemon = new FleetDaemon(fleet);
  const stop = new AbortController();
  const log = vi.fn();
  const served = serveDaemon(daemon, path, log, stop.signal);
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(`Fleet daemon listening on ${path}.`));
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await expect(serveDaemon(new FleetDaemon(fleet), path, log)).rejects.toThrow('already running');
  expect(await toDaemon(path, unit('a', { activity: 'running' }))).toBe(true);
  await vi.waitFor(() => expect(daemon.units).toBe(1));
  stop.abort();
  await served;
  await expect(stat(path)).rejects.toThrow();
  expect(await toDaemon(path, unit('a', {}))).toBe(false);
  await rm(dir, { recursive: true, force: true });
});
