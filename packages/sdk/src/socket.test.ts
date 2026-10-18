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
      // Answers keepalive pings as the server does.
      send(data: string) {
        if (data === 'ping') queueMicrotask(() => this.emit('message', Buffer.from('pong')));
      }
      close() {}
    },
  };
});
import { backoff, Herald, LiveSocket, type Message } from './index';
class FakeSocket extends EventEmitter {
  closed = false;
  terminated = false;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  terminate() {
    this.terminated = true;
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
it('pings every 30 s and drops a socket that misses a pong', () => {
  vi.useFakeTimers();
  const opened: FakeSocket[] = [];
  const live = new LiveSocket(
    () => {
      opened.push(new FakeSocket());
      return opened.at(-1)!;
    },
    () => 1000,
  );
  const events: string[] = [];
  live.subscribe((event) => events.push(event.type));
  opened[0].emit('open');
  vi.advanceTimersByTime(30_000);
  expect(opened[0].sent).toEqual(['ping']);
  // A pong wakes no one.
  opened[0].emit('message', Buffer.from('pong'));
  vi.advanceTimersByTime(30_000);
  expect(opened[0].sent).toEqual(['ping', 'ping']);
  expect(events).toEqual(['open']);
  // No answer: the half-open socket is dropped at once and a new one follows.
  vi.advanceTimersByTime(30_000);
  expect(opened[0].terminated).toBe(true);
  expect(live.connected).toBe(false);
  expect(events).toEqual(['open', 'close']);
  opened[0].emit('close');
  expect(events).toEqual(['open', 'close']);
  vi.advanceTimersByTime(1000);
  expect(opened).toHaveLength(2);
  expect(opened[0].sent).toHaveLength(2);
});
it('polls slowly while the socket is up and checks only on newer sync revisions', async () => {
  vi.useFakeTimers();
  const client = new Herald({ apiKey: 'test-only', url: 'https://herald.test' });
  let release = () => {};
  const get = vi
    .spyOn(client, 'get')
    .mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ status: 'pending' } as Message))),
    )
    .mockResolvedValue({ status: 'pending' } as Message);
  const controller = new AbortController();
  const waiting = client.wait('one', { signal: controller.signal }).catch(() => 'aborted');
  const socket = sockets[0] as unknown as EventEmitter;
  const calls = async () => {
    await vi.advanceTimersByTimeAsync(0);
    return get.mock.calls.length;
  };
  expect(await calls()).toBe(1);
  // An open during a check earns one more check once it finishes.
  socket.emit('open');
  expect(await calls()).toBe(1);
  release();
  expect(await calls()).toBe(2);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(await calls()).toBe(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(await calls()).toBe(3);
  const event = (data: string) => socket.emit('message', Buffer.from(data));
  event('{"type":"sync","revision":5}');
  expect(await calls()).toBe(4);
  event('{"type":"sync","revision":5}');
  event('{"type":"sync","revision":4}');
  event('{"type":"other"}');
  expect(await calls()).toBe(4);
  // Unparsable or revision-less sync events still wake.
  event('not json');
  expect(await calls()).toBe(5);
  event('{"type":"sync"}');
  expect(await calls()).toBe(6);
  // While the socket is down, the poll returns to 30 s.
  socket.emit('close');
  expect(await calls()).toBe(6);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await calls()).toBe(7);
  controller.abort();
  expect(await waiting).toBe('aborted');
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
