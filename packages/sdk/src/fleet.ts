import { z } from 'zod';
import {
  trackRefSchema,
  unitBatchSchema,
  type FleetWorld,
  type SealedEnvelope,
  type UnitInput,
} from './schema/index.js';
import { HeraldError } from './http.js';
import { backoff } from './socket.js';
import type { UnitStateInput } from './keyed.js';
export type { UnitStateInput };
/** One unit to report: `ttl` seconds (30-3600, default 600) without a write fade it to idle. */
export type UnitReport = { key: string; ttl?: number; state: UnitStateInput };
/**
 * A reporter socket's error frame: the server refused a frame (all its units). `retryAfter` (s)
 * comes with `FLEET_RATE`, `resetsAt` with `FLEET_QUOTA`.
 */
export type FleetFrameError = {
  error: string;
  code?: string;
  resetsAt?: string;
  retryAfter?: number;
};
export type FleetReportOptions = {
  signal?: AbortSignal;
  /** `false` fails at once on a rate limit instead of waiting out a short Retry-After. */
  retry?: boolean;
};
/** The parts of a `ws` WebSocket a reporter uses. */
export interface ReporterSocket {
  on(
    event: 'open' | 'message' | 'close' | 'error' | 'pong',
    listener: (...args: never[]) => void,
  ): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping?(): void;
  terminate?(): void;
}
export type ReporterOptions = {
  /** A refused frame; its units were neither stored nor shown. */
  onError?: (error: FleetFrameError) => void;
  onOpen?: () => void;
  /** A viewer joined: re-send live units with `persist: false` so it sees current state. */
  onSync?: () => void;
  /** The socket closed; it reconnects with jittered backoff until `close()`. */
  onClose?: (code: number, reason: string) => void;
  /** Reconnect delay by attempt; defaults to 1 s doubling to 30 s with jitter. */
  delay?: (attempt: number) => number;
  /** Frames sent per rolling minute, at most; the server closes sockets past 120. */
  framesPerMinute?: number;
  /** Protocol ping interval in ms on sockets that support it; 0 turns it off. */
  keepalive?: number;
};
/** What the client gives the Fleet surface: requests, sealing and its socket. */
export type FleetHost = {
  request<T>(
    path: string,
    body?: unknown,
    options?: { method?: string; signal?: AbortSignal; retry?: boolean },
  ): Promise<T>;
  seal(world: string, key: string, state: UnitStateInput): Promise<SealedEnvelope>;
  /** Runs `post`, reloading keys and running it once more after `409 E2EE_STALE_KEY`. */
  sealed<T>(post: () => Promise<T>): Promise<T>;
  /** Reloads the key directory, e.g. after a reporter frame was refused for a stale team key. */
  refresh(): Promise<unknown>;
  connect(path: string): ReporterSocket;
};
const path = (id: string) => encodeURIComponent(id);
/** A socket held this long counts as healthy, so the next reconnect starts from 1 s again. */
const STABLE = 30_000;
/**
 * Fleet reporting: each linked repo is a world; agents report their focus as sealed units.
 * Needs a connection token with the `fleet:write` scope.
 */
export class Fleet {
  #host: FleetHost;
  constructor(host: FleetHost) {
    this.#host = host;
  }
  /** The workspace's worlds. */
  async worlds(): Promise<FleetWorld[]> {
    return (await this.#host.request<{ worlds: FleetWorld[] }>('/fleet')).worlds;
  }
  /** A world by id or by its repo's `owner/repo` (case-insensitive); undefined when unlinked. */
  async world(repoOrId: string): Promise<FleetWorld | undefined> {
    const want = repoOrId.toLowerCase();
    return (await this.worlds()).find(
      (w) => w.id === repoOrId || w.repo.fullName.toLowerCase() === want,
    );
  }
  /** Seals units for `world` into a batch; throws on invalid or oversized states. */
  async units(world: string, units: UnitReport[]): Promise<UnitInput[]> {
    const keys = new Set(units.map((u) => u.key));
    if (!units.length || units.length > 50)
      throw new HeraldError('Report 1 to 50 units at once.', 400);
    if (keys.size !== units.length) throw new HeraldError('Unit keys must be unique.', 400);
    const sealed = await Promise.all(
      units.map(async (u) => ({
        key: u.key,
        ttl: u.ttl ?? 600,
        sealed: await this.#host.seal(world, u.key, u.state),
      })),
    );
    const batch = unitBatchSchema.safeParse({ units: sealed });
    if (!batch.success) throw new HeraldError(z.prettifyError(batch.error), 400);
    return batch.data.units;
  }
  /**
   * Writes units over HTTP (each at most every 10 s). Rejects with 429 `FLEET_RATE`
   * (`retryAfter`) or `FLEET_QUOTA` (`resetsAt`) when refused.
   */
  report(
    world: string,
    units: UnitReport[],
    options: FleetReportOptions = {},
  ): Promise<{ units: { key: string; expiresAt: string }[] }> {
    return this.#host.sealed(async () =>
      this.#host.request(
        `/fleet/worlds/${path(world)}/units`,
        { units: await this.units(world, units) },
        options,
      ),
    );
  }
  /** Removes a unit this connection wrote. */
  remove(world: string, key: string, options: FleetReportOptions = {}): Promise<void> {
    return this.#host.request(`/fleet/worlds/${path(world)}/units/${path(key)}`, undefined, {
      ...options,
      method: 'DELETE',
    });
  }
  /** Asks Herald to follow a branch that has no pull request (202; GitHub is read later). */
  async track(world: string, ref: string): Promise<void> {
    const body = trackRefSchema.safeParse({ ref });
    if (!body.success) throw new HeraldError(z.prettifyError(body.error), 400);
    await this.#host.request(`/fleet/worlds/${path(world)}/refs`, body.data, { method: 'PUT' });
  }
  /** A reporter socket for `world`: frequent updates without HTTP's 10 s rate limit. */
  reporter(world: string, options: ReporterOptions = {}): FleetReporter {
    return new FleetReporter(
      () => this.#host.connect(`/fleet/ws?world=${path(world)}`),
      (units) => this.units(world, units),
      {
        ...options,
        onError: (error) => {
          // A rotated team key: later frames seal to the new one.
          if (error.code === 'E2EE_STALE_KEY') void this.#host.refresh().catch(() => {});
          options.onError?.(error);
        },
      },
    );
  }
}
/**
 * One world's reporter socket. It connects at once and reconnects with jittered backoff until
 * `close()`; `send` returns false while it is down or past the frame budget.
 */
export class FleetReporter {
  #connect: () => ReporterSocket;
  #seal: (units: UnitReport[]) => Promise<UnitInput[]>;
  #options: ReporterOptions;
  #socket?: ReporterSocket;
  #open = false;
  #closed = false;
  #attempt = 0;
  #timer?: ReturnType<typeof setTimeout>;
  #ping?: ReturnType<typeof setInterval>;
  #sent: number[] = [];
  constructor(
    connect: () => ReporterSocket,
    seal: (units: UnitReport[]) => Promise<UnitInput[]>,
    options: ReporterOptions = {},
  ) {
    this.#connect = connect;
    this.#seal = seal;
    this.#options = options;
    this.#start();
  }
  /** Whether the socket is open. */
  get connected() {
    return this.#open;
  }
  /** Frames left in the current minute. */
  get budget() {
    const now = Date.now();
    this.#sent = this.#sent.filter((t) => now - t < 60_000);
    return (this.#options.framesPerMinute ?? 100) - this.#sent.length;
  }
  /**
   * Seals and sends up to 50 units in one frame; `persist: false` only reaches live viewers.
   * Resolves false when the socket is down or the frame budget is spent; throws on invalid units.
   */
  async send(units: UnitReport[], options: { persist?: boolean } = {}): Promise<boolean> {
    const sealed = await this.#seal(units);
    const socket = this.#socket;
    if (!this.#open || !socket || this.budget <= 0) return false;
    try {
      socket.send(
        JSON.stringify({ type: 'units', units: sealed, persist: options.persist ?? true }),
      );
    } catch {
      return false;
    }
    this.#sent.push(Date.now());
    return true;
  }
  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    clearInterval(this.#ping);
    const socket = this.#socket;
    this.#socket = undefined;
    this.#open = false;
    socket?.close(1000, 'Done');
  }
  #start() {
    this.#timer = undefined;
    if (this.#closed) return;
    let openedAt = 0,
      answered = true;
    const socket = this.#connect();
    this.#socket = socket;
    const closed = (code = 1006, reason = '') => {
      if (this.#socket !== socket) return;
      clearInterval(this.#ping);
      this.#socket = undefined;
      this.#open = false;
      this.#options.onClose?.(code, reason);
      if (this.#closed) return;
      if (openedAt && Date.now() - openedAt >= STABLE) this.#attempt = 0;
      this.#timer = setTimeout(
        () => this.#start(),
        (this.#options.delay ?? backoff)(this.#attempt++),
      );
    };
    socket.on('open', () => {
      openedAt = Date.now();
      this.#open = true;
      const every = this.#options.keepalive ?? 30_000;
      if (socket.ping && every > 0)
        // A half-open socket never closes by itself; an unanswered ping ends it.
        this.#ping = setInterval(() => {
          if (!answered) {
            closed();
            return void (socket.terminate ?? socket.close).call(socket);
          }
          answered = false;
          try {
            socket.ping!();
          } catch {
            /* The close event follows. */
          }
        }, every);
      this.#options.onOpen?.();
    });
    socket.on('pong', () => void (answered = true));
    socket.on('message', (data: unknown) => {
      answered = true;
      let frame: {
        type?: unknown;
        error?: unknown;
        code?: unknown;
        resetsAt?: unknown;
        retryAfter?: unknown;
      };
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (frame?.type === 'sync') return void this.#options.onSync?.();
      if (frame?.type !== 'error') return;
      this.#options.onError?.({
        error: typeof frame.error === 'string' ? frame.error : 'The frame was refused.',
        ...(typeof frame.code === 'string' ? { code: frame.code } : {}),
        ...(typeof frame.resetsAt === 'string' ? { resetsAt: frame.resetsAt } : {}),
        ...(typeof frame.retryAfter === 'number' ? { retryAfter: frame.retryAfter } : {}),
      });
    });
    socket.on('error', () => {});
    socket.on('close', (code: number, reason: unknown) => closed(code, String(reason ?? '')));
  }
}
