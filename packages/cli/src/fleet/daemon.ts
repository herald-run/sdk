import { chmod, mkdir, unlink } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import {
  HeraldError,
  type Fleet,
  type FleetFrameError,
  type FleetReporter,
  type FleetWorld,
  type UnitState,
} from '@herald-run/sdk';
import { mergeState, updateSchema, type FleetUpdate } from './protocol';
type Reporter = Pick<FleetReporter, 'send' | 'close'>;
export type DaemonFleet = Pick<Fleet, 'worlds' | 'remove' | 'track'> & {
  reporter(world: string, options: Parameters<Fleet['reporter']>[1]): Reporter;
};
export type DaemonOptions = {
  now?: () => number;
  log?: (line: string) => void;
  /** Least time between two sends of one unit (ms). */
  sendEvery?: number;
  /** A live unit is stored at least this often (ms). */
  persistEvery?: number;
  /** Units without a local update this long are no longer re-sent and fade to idle (ms). */
  staleAfter?: number;
};
type Unit = {
  key: string;
  repo: string;
  ttl: number;
  state: Partial<UnitState>;
  /** The last update's ref is on the remote. */
  pushed: boolean;
  dirty: boolean;
  touched: number;
  sentAt: number;
  persistedAt: number;
  /** What was last stored: a change of any of these is stored at once. */
  persisted?: string;
  /** A viewer joined: re-send live with the TTL left on the next tick. */
  resend?: boolean;
};
/** Default unit TTL (s); it outlasts the refresh, so active units never fade between sends. */
export const UNIT_TTL = 900;
type World = { id: string; defaultBranch: string; reporter: Reporter; pausedUntil: number };
// Activity is not here: its changes are live-only, and joining viewers get it from `sync`.
const snapshot = (s: Partial<UnitState>) =>
  JSON.stringify([s.ref, s.area, s.name, s.kind, s.task, s.squad, s.parent]);
/**
 * Coalesces local unit updates and sends them on one reporter socket per world: each unit at
 * most every `sendEvery`, stored on a ref, area, name, kind, task, squad or parent change or every
 * `persistEvery`, re-sent before its TTL while active, and re-sent live on `sync` with the TTL
 * left, so viewers joining never extend it.
 */
export class FleetDaemon {
  #fleet: DaemonFleet;
  #now: () => number;
  #log: (line: string) => void;
  #sendEvery: number;
  #persistEvery: number;
  #staleAfter: number;
  #units = new Map<string, Unit>();
  #removals = new Map<string, string>();
  #worlds = new Map<string, World>();
  #list?: { at: number; worlds: FleetWorld[] };
  #tracked = new Set<string>();
  #missing = new Set<string>();
  #ticking = false;
  constructor(fleet: DaemonFleet, options: DaemonOptions = {}) {
    this.#fleet = fleet;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
    this.#sendEvery = options.sendEvery ?? 2000;
    this.#persistEvery = options.persistEvery ?? 300_000;
    this.#staleAfter = options.staleAfter ?? 1_800_000;
  }
  get units() {
    return this.#units.size;
  }
  update(update: FleetUpdate) {
    if (update.remove) {
      this.#units.delete(update.key);
      this.#removals.set(update.key, update.repo);
      return;
    }
    this.#removals.delete(update.key);
    const unit = this.#units.get(update.key);
    const next: Unit = unit ?? {
      key: update.key,
      repo: update.repo,
      ttl: UNIT_TTL,
      state: {},
      pushed: false,
      dirty: true,
      touched: 0,
      sentAt: -Infinity,
      persistedAt: -Infinity,
    };
    next.repo = update.repo;
    next.ttl = update.ttl ?? next.ttl;
    next.state = mergeState(next.state, update.state);
    next.pushed = update.pushed === true;
    next.dirty = true;
    next.touched = this.#now();
    this.#units.set(update.key, next);
  }
  /** Sends what is due; called about every second. */
  async tick() {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#flush();
    } finally {
      this.#ticking = false;
    }
  }
  close() {
    for (const world of this.#worlds.values()) world.reporter.close();
    this.#worlds.clear();
  }
  async #world(repo: string): Promise<World | undefined> {
    const known = this.#worlds.get(repo);
    if (known) return known;
    const now = this.#now();
    if (!this.#list || now - this.#list.at > 60_000)
      this.#list = { at: now, worlds: await this.#fleet.worlds() };
    const found = this.#list.worlds.find(
      (w) => w.repo.fullName.toLowerCase() === repo.toLowerCase(),
    );
    if (!found) {
      if (!this.#missing.has(repo)) this.#log(`No Fleet world for ${repo}; add it in Herald.`);
      this.#missing.add(repo);
      return undefined;
    }
    this.#missing.delete(repo);
    const world: World = {
      id: found.id,
      defaultBranch: found.repo.defaultBranch,
      pausedUntil: 0,
      reporter: undefined as unknown as Reporter,
    };
    world.reporter = this.#fleet.reporter(found.id, {
      onError: (error) => this.#refused(repo, world, error),
      onOpen: () => this.#log(`Reporting to ${repo}.`),
      onSync: () => this.#sync(repo),
    });
    this.#worlds.set(repo, world);
    return world;
  }
  /** Units the server may still show are re-sent live on the next tick. */
  #sync(repo: string) {
    const now = this.#now();
    for (const u of this.#units.values())
      if (u.repo === repo && now - u.sentAt < u.ttl * 1000) u.resend = true;
  }
  /** A refused frame: its units are sent and stored again, after a pause where one applies. */
  #refused(repo: string, world: World, error: FleetFrameError) {
    const now = this.#now();
    for (const u of this.#units.values())
      if (u.repo === repo) Object.assign(u, { dirty: true, persisted: undefined });
    if (error.code === 'E2EE_STALE_KEY') return;
    this.#log(`${repo}: ${error.error}${error.code ? ` (${error.code})` : ''}`);
    if (error.code === 'FLEET_RATE' && error.retryAfter !== undefined) {
      world.pausedUntil = now + error.retryAfter * 1000;
      return;
    }
    if (error.code !== 'FLEET_QUOTA') {
      world.pausedUntil = now + 60_000;
      return;
    }
    const resets = error.resetsAt ? Date.parse(error.resetsAt) : NaN;
    world.pausedUntil = Number.isNaN(resets) ? now + 300_000 : resets;
    if (world.pausedUntil > now)
      this.#log(`${repo}: paused until ${new Date(world.pausedUntil).toISOString()}.`);
  }
  /** A resend's TTL is what is left, at least the server's 30 s. */
  #report = (u: Unit, now: number, resend: boolean) => ({
    key: u.key,
    ttl: resend ? Math.max(30, Math.ceil((u.sentAt + u.ttl * 1000 - now) / 1000)) : u.ttl,
    state: u.state as UnitState,
  });
  async #flush() {
    const now = this.#now();
    for (const [key, repo] of [...this.#removals]) {
      this.#removals.delete(key);
      const world = await this.#world(repo).catch(() => undefined);
      if (world)
        await this.#fleet.remove(world.id, key, { retry: false }).catch((e: Error) => {
          if (!(e instanceof HeraldError && [404, 409].includes(e.status)))
            this.#log(`Could not remove ${key}: ${e.message}`);
        });
    }
    const due = new Map<World, Record<'persist' | 'live' | 'resend', Unit[]>>();
    for (const unit of [...this.#units.values()]) {
      if (now - unit.touched > this.#staleAfter) {
        this.#units.delete(unit.key);
        continue;
      }
      const active = !['idle', 'done'].includes(unit.state.activity ?? 'idle');
      const refresh = Math.min(this.#persistEvery, unit.ttl * 750);
      const send =
        // A resend with a local change is a normal send, which may store it.
        (unit.dirty && (unit.resend || now - unit.sentAt >= this.#sendEvery)) ||
        (active && now - unit.sentAt >= refresh);
      if (!send && unit.resend && now - unit.sentAt >= unit.ttl * 1000) unit.resend = false;
      if (!(send || unit.resend) || !unit.state.name) continue;
      const world = await this.#world(unit.repo).catch((e: Error) => {
        this.#log(`Could not list Fleet worlds: ${e.message}`);
        return undefined;
      });
      if (!world || world.pausedUntil > now) continue;
      const persist =
        unit.persisted !== snapshot(unit.state) || now - unit.persistedAt >= this.#persistEvery;
      const group = due.get(world) ?? { persist: [], live: [], resend: [] };
      group[!send ? 'resend' : persist ? 'persist' : 'live'].push(unit);
      due.set(world, group);
    }
    for (const [world, group] of due)
      for (const kind of ['persist', 'live', 'resend'] as const)
        for (let i = 0; i < group[kind].length; i += 50)
          await this.#send(world, group[kind].slice(i, i + 50), kind, now);
  }
  async #send(world: World, units: Unit[], kind: 'persist' | 'live' | 'resend', now: number) {
    const persist = kind === 'persist',
      resend = kind === 'resend';
    let sent: boolean;
    try {
      sent = await world.reporter.send(
        units.map((u) => this.#report(u, now, resend)),
        { persist },
      );
    } catch (error) {
      // An invalid state is not retried until the unit changes.
      this.#log(`Could not seal units: ${(error as Error).message}`);
      for (const u of units)
        Object.assign(u, { dirty: false, resend: false, sentAt: resend ? u.sentAt : now });
      return;
    }
    if (!sent) return;
    for (const u of units) {
      u.dirty = u.resend = false;
      if (!resend) u.sentAt = now;
      if (persist) Object.assign(u, { persistedAt: now, persisted: snapshot(u.state) });
      const ref = u.state.ref;
      const id = `${world.id}:${ref}`;
      if (ref && u.pushed && ref !== world.defaultBranch && !this.#tracked.has(id)) {
        this.#tracked.add(id);
        void this.#fleet
          .track(world.id, ref)
          .catch((e: Error) => this.#log(`Could not track ${ref}: ${e.message}`));
      }
    }
  }
}
/** Longest accepted JSON line on the daemon socket. */
const MAX_LINE = 64 * 1024;
/** Feeds JSON lines from a local client into the daemon; bad lines are dropped. */
export function readLines(socket: Socket, daemon: Pick<FleetDaemon, 'update'>) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE && !buffer.includes('\n')) return socket.destroy();
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const parsed = updateSchema.safeParse(JSON.parse(line));
        if (parsed.success) daemon.update(parsed.data as FleetUpdate);
      } catch {
        /* Not JSON. */
      }
    }
  });
  socket.on('error', () => {});
}
const alive = (path: string) =>
  new Promise<boolean>((resolve) => {
    const probe = connect(path);
    probe.on('connect', () => (probe.destroy(), resolve(true)));
    probe.on('error', () => resolve(false));
  });
/**
 * Runs the daemon on a 0600 unix socket until `signal` aborts or SIGINT/SIGTERM; one per socket.
 */
export async function serveDaemon(
  daemon: FleetDaemon,
  path: string,
  log: (line: string) => void,
  signal?: AbortSignal,
) {
  if (await alive(path)) throw new Error(`A Fleet daemon is already running on ${path}.`);
  await unlink(path).catch(() => {});
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const server = createServer((socket) => readLines(socket, daemon));
  const mask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
  } finally {
    process.umask(mask);
  }
  await chmod(path, 0o600);
  log(`Fleet daemon listening on ${path}.`);
  const timer = setInterval(() => void daemon.tick(), 1000);
  let stop = () => {};
  await new Promise<void>((resolve) => {
    stop = resolve;
    if (signal?.aborted) return resolve();
    signal?.addEventListener('abort', stop, { once: true });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  clearInterval(timer);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await unlink(path).catch(() => {});
  daemon.close();
  log('Fleet daemon stopped.');
}
