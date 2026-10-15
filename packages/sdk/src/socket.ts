/** The part of a `ws` WebSocket the multiplexer uses. */
export interface EventSocket {
  on(event: 'open' | 'message' | 'close' | 'error', listener: () => void): unknown;
  close(): void;
}
/** Reconnect delay: exponential from 1 s, capped at 30 s, with 50–100% jitter. */
export const backoff = (attempt: number, random = Math.random) =>
  Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + random() / 2);
/** A socket held this long counts as healthy, so the next reconnect starts from 1 s again. */
const STABLE = 30_000;
/** One live socket shared by every waiter; each open or event wakes all subscribers. */
export class LiveSocket {
  #listeners = new Set<() => void>();
  #socket?: EventSocket;
  #timer?: ReturnType<typeof setTimeout>;
  #attempt = 0;
  constructor(
    private connect: () => EventSocket,
    private delay: (attempt: number) => number = backoff,
  ) {}
  get size() {
    return this.#listeners.size;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (!this.#socket && !this.#timer) this.#open();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size) return;
      clearTimeout(this.#timer);
      this.#timer = undefined;
      const socket = this.#socket;
      this.#socket = undefined;
      socket?.close();
    };
  }
  #wake = () => {
    for (const listener of [...this.#listeners]) listener();
  };
  #open() {
    this.#timer = undefined;
    let openedAt = 0;
    const socket = this.connect();
    this.#socket = socket;
    socket.on('open', () => {
      openedAt = Date.now();
      this.#wake();
    });
    socket.on('message', this.#wake);
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      if (!this.#listeners.size) return;
      if (openedAt && Date.now() - openedAt >= STABLE) this.#attempt = 0;
      this.#timer = setTimeout(() => this.#open(), this.delay(this.#attempt++));
    });
  }
}
