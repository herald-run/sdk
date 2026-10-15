import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const sockets = vi.hoisted(() => [] as Array<{ url: string; close: () => void }>);
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: class extends EventEmitter {
      constructor(public url: string) {
        super();
        sockets.push(this);
      }
      close() {}
    },
  };
});
import { backoff, Herald, LiveSocket } from './index';
class FakeSocket extends EventEmitter {
  closed = false;
  close() {
    this.closed = true;
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sockets.length = 0;
});
it('backs off exponentially with jitter, capped at 30 s', () => {
  expect(backoff(0, () => 0)).toBe(500);
  expect(backoff(0, () => 1)).toBe(1000);
  expect(backoff(3, () => 1)).toBe(8000);
  expect(backoff(20, () => 1)).toBe(30_000);
  expect(backoff(20, () => 0)).toBe(15_000);
});
it('shares one socket, wakes every subscriber and reconnects with growing delays', () => {
  vi.useFakeTimers();
  const opened: FakeSocket[] = [];
  const delays: number[] = [];
  const live = new LiveSocket(
    () => {
      opened.push(new FakeSocket());
      return opened.at(-1)!;
    },
    (attempt) => {
      delays.push(attempt);
      return 1000 * 2 ** attempt;
    },
  );
  const a = vi.fn(),
    b = vi.fn();
  const stopA = live.subscribe(a);
  const stopB = live.subscribe(b);
  expect(opened).toHaveLength(1);
  opened[0].emit('open');
  opened[0].emit('message');
  expect([a.mock.calls.length, b.mock.calls.length]).toEqual([2, 2]);
  opened[0].emit('close');
  vi.advanceTimersByTime(999);
  expect(opened).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(opened).toHaveLength(2);
  opened[1].emit('close');
  vi.advanceTimersByTime(2000);
  expect(opened).toHaveLength(3);
  expect(delays).toEqual([0, 1]);
  // A socket that stayed up resets the backoff.
  opened[2].emit('open');
  vi.advanceTimersByTime(30_000);
  opened[2].emit('close');
  expect(delays).toEqual([0, 1, 0]);
  vi.advanceTimersByTime(1000);
  stopA();
  expect(opened[3].closed).toBe(false);
  stopB();
  expect(opened[3].closed).toBe(true);
  opened[3].emit('close');
  vi.advanceTimersByTime(60_000);
  expect(opened).toHaveLength(4);
});
it('multiplexes concurrent waits and watches over one WebSocket', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url) =>
      String(url).includes('?after=')
        ? Response.json([])
        : Response.json({ id: String(url).split('/').pop(), status: 'pending' }),
    );
  const client = new Herald({ apiKey: 'test-only', url: 'https://herald.test' });
  const controller = new AbortController();
  const waits = ['one', 'two', 'three'].map((id) =>
    client.wait(id, { signal: controller.signal }).catch(() => 'aborted'),
  );
  const stop = client.watch(() => {});
  expect(sockets).toHaveLength(1);
  expect(sockets[0].url).toBe('wss://herald.test/ws');
  expect(client.live.size).toBe(4);
  controller.abort();
  expect(await Promise.all(waits)).toEqual(['aborted', 'aborted', 'aborted']);
  stop();
  expect(client.live.size).toBe(0);
  expect(fetch).toHaveBeenCalled();
});
