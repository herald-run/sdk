import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Herald } from './index';
import { idleBody } from './upload';
const received: number[] = [];
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST') {
    for await (const chunk of req) void chunk;
    return res.end(JSON.stringify({ id: crypto.randomUUID(), name: 'f', size: 0, type: 'x' }));
  }
  let size = 0;
  try {
    for await (const chunk of req) size += chunk.length;
  } catch {
    return; // The client aborted a stalled upload.
  }
  received.push(size);
  res.end(JSON.stringify({ ok: true }));
});
let client: Herald;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  client = new Herald({ url: 'http://127.0.0.1:' + port, apiKey: 'test-only' });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
it('streams uploads that run longer than the idle timeout while they progress', async () => {
  async function* slow() {
    for (let i = 0; i < 5; i++) {
      await wait(80);
      yield new Uint8Array(1000);
    }
  }
  await client.upload('slow.bin', slow(), undefined, { size: 5000, idleTimeout: 0.25 });
  expect(received.at(-1)).toBe(5000);
  await client.upload('small.bin', new Uint8Array(200_000));
  expect(received.at(-1)).toBe(200_000);
});
it('aborts a stalled upload after the idle timeout', async () => {
  async function* stalled() {
    yield new Uint8Array(10);
    await wait(1500);
  }
  const started = Date.now();
  await expect(
    client.upload('stalled.bin', stalled(), undefined, { size: 20, idleTimeout: 0.2 }),
  ).rejects.toThrow('Upload stalled');
  expect(Date.now() - started).toBeLessThan(1000);
  await expect(client.upload('unsized.bin', stalled())).rejects.toThrow('byte size');
});
it('pulls large chunks in small slices, so each slice on a slow link is progress', async () => {
  const { body, done } = idleBody(new Uint8Array(40_000), 1000, new AbortController());
  const sizes: number[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) sizes.push(chunk.length);
  done();
  expect(sizes).toEqual([16384, 16384, 7232]);
});
