import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { keyedClient } from '../fixtures/client';
import { Herald } from './index';
let base: string,
  destination: string,
  received = 0;
const sink = createServer((_, res) => {
  received++;
  res.end('{}');
});
const source = createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  if (req.url === '/api/v1/files' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'reserved-file' }));
  } else {
    res.writeHead(req.url?.includes('308') ? 308 : 307, { Location: destination });
    res.end();
  }
});
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port;
}
beforeAll(async () => {
  destination = await listen(sink);
  base = await listen(source);
});
afterAll(async () => {
  for (const server of [source, sink]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it.each([307, 308])(
  'does not forward request bodies or credentials across %s redirects',
  async (status) => {
    const client = new Herald({ url: base, apiKey: 'test-only-token' });
    await expect(
      client.request(
        '/redirect-' + status,
        { private: 'test-only-content' },
        { key: 'stable-key' },
      ),
    ).rejects.toMatchObject({ status, message: 'Herald does not accept API redirects.' });
    expect(received).toBe(0);
  },
);
it('does not forward attachments across redirects', async () => {
  const client = await keyedClient(base);
  await expect(
    client.upload('private.txt', new TextEncoder().encode('test-only-private-file')),
  ).rejects.toMatchObject({ status: 307 });
  expect(received).toBe(0);
});
it('accepts origins only, so relative API paths cannot target a different deployment', () => {
  expect(() => new Herald({ url: 'https://app.herald.run/other' })).toThrow('server origin');
});
