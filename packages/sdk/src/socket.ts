/** The part of a `ws` WebSocket the multiplexer uses. */
export interface EventSocket {
  on(event: 'open' | 'message' | 'close' | 'error', listener: (data?: unknown) => void): unknown;
  send(data: string): void;
  close(): void;
  /** Drops the connection at once, without a closing handshake (`ws`). */
  terminate?(): void;
}
/**
 * What woke a listener: the socket opened or closed, a sync event arrived (`revision` is absent
 * when the event did not carry a usable one, or could not be parsed), or another event arrived.
 */
export type LiveEvent = { type: 'open' | 'close' | 'event' } | { type: 'sync'; revision?: number };
/** The server answers this text frame itself, without waking the inbox. */
const PING = 'ping',
  PONG = 'pong';
const parse = (data: unknown): LiveEvent | null => {
  if (String(data) === PONG) return null;
  try {
    const event = JSON.parse(String(data)) as { type?: unknown; revision?: unknown } | null;
    if (typeof event?.type === 'string' && event.type !== 'sync') return { type: 'event' };
    const revision = event?.revision;
    return Number.isSafeInteger(revision)
      ? { type: 'sync', revision: revision as number }
      : { type: 'sync' };
  } catch {
    return { type: 'sync' };
  }
};
/** Reconnect delay: exponential from 1 s, capped at 30 s, with 50–100% jitter. */
export const backoff = (attempt: number, random = Math.random) =>
  Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + random() / 2);
/** A socket held this long counts as healthy, so the next reconnect starts from 1 s again. */
const STABLE = 30_000;
/** A ping goes out this often; a socket that has not answered the previous one is dropped. */
export const KEEPALIVE = 30_000;
/** One live socket shared by every waiter; each open, close or event wakes all subscribers. */
export class LiveSocket {
  #listeners = new Set<(event: LiveEvent) => void>();
  #connected = false;
  #socket?: EventSocket;
  #timer?: ReturnType<typeof setTimeout>;
  #attempt = 0;
  constructor(
    private connect: () => EventSocket,
    private delay: (attempt: number) => number = backoff,
    private keepalive = KEEPALIVE,
  ) {}
  get size() {
    return this.#listeners.size;
  }
  /** Whether the socket is open, so events arrive without polling. */
  get connected() {
    return this.#connected;
  }
  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.#listeners.add(listener);
    if (!this.#socket && !this.#timer) this.#open();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size) return;
      clearTimeout(this.#timer);
      this.#timer = undefined;
      const socket = this.#socket;
      this.#socket = undefined;
      this.#connected = false;
      clearInterval(this.#ping);
      socket?.close();
    };
  }
  #ping?: ReturnType<typeof setInterval>;
  #wake(event: LiveEvent) {
    for (const listener of [...this.#listeners]) listener(event);
  }
  #open() {
    this.#timer = undefined;
    let openedAt = 0;
    const socket = this.connect();
    this.#socket = socket;
    let answered = true;
    const closed = () => {
      if (this.#socket !== socket) return;
      clearInterval(this.#ping);
      this.#socket = undefined;
      this.#connected = false;
      if (!this.#listeners.size) return;
      this.#wake({ type: 'close' });
      if (openedAt && Date.now() - openedAt >= STABLE) this.#attempt = 0;
      this.#timer = setTimeout(() => this.#open(), this.delay(this.#attempt++));
    };
    socket.on('open', () => {
      openedAt = Date.now();
      this.#connected = true;
      clearInterval(this.#ping);
      // A half-open socket never closes by itself; an unanswered ping ends it.
      this.#ping = setInterval(() => {
        if (!answered) {
          closed();
          return void (socket.terminate ?? socket.close).call(socket);
        }
        answered = false;
        try {
          socket.send(PING);
        } catch {
          /* The close event follows. */
        }
      }, this.keepalive);
      this.#wake({ type: 'open' });
    });
    socket.on('message', (data) => {
      answered = true;
      const event = parse(data);
      if (event) this.#wake(event);
    });
    socket.on('error', () => {});
    socket.on('close', closed);
  }
}
