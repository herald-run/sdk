import { afterEach, expect, it, vi } from 'vitest';
import { createKeys, seal, unseal } from './schema/crypto.js';
import { Herald, HeraldError, version } from './index';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const client = () => new Herald({ apiKey: 'test-only', url: 'https://herald.test' });
// Request and response shapes of every method: contracts.test.ts.
it('reveals collected secret fields with the requester key', async () => {
  const keys = await createKeys();
  const envelope = await seal('test-only-value', keys.publicKey);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ secret: envelope }));
  expect(await client().revealSecrets('m', keys.privateKey)).toEqual({ secret: 'test-only-value' });
});
it('waits out Retry-After, even for unkeyed writes the server rejected unprocessed', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      Response.json({ error: 'Slow down.' }, { status: 429, headers: { 'Retry-After': '2' } }),
    )
    .mockResolvedValueOnce(Response.json({ ok: true }));
  const result = client().request('/tasks/t/update', { lease: 'l', status: 'failed' });
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual({ ok: true });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('checks status and content type before parsing JSON', async () => {
  const html = () =>
    new Response('<html>Bad gateway</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => html());
  const herald = new Herald({ url: 'https://herald.test' });
  // Unkeyed writes never retry a 5xx.
  await expect(herald.request('/messages/m/cancel', {})).rejects.toMatchObject({
    status: 502,
    message: 'Herald request failed (502).',
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response('<html>Portal</html>', { headers: { 'Content-Type': 'text/html' } }),
  );
  await expect(herald.request('/messages')).rejects.toBeInstanceOf(HeraldError);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  expect(await herald.request('/messages/m', undefined, { method: 'DELETE' })).toBeUndefined();
});
it('leaves retries to callers that opt out', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json({ error: 'Slow down.' }, { status: 429, headers: { 'Retry-After': '1' } }),
    );
  await expect(
    client().updateTask('t', { lease: 'l', logs: [] }, { idempotencyKey: 'k', retry: false }),
  ).rejects.toMatchObject({ status: 429, retryAfter: 1 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('opens envelopes sealed by the Python SDK', async () => {
  const { python } = (await import('../fixtures/crypto-vectors.json')).default;
  expect(await unseal(python.envelope, python.privateKey as JsonWebKey)).toBe(
    'test-only-value from Python',
  );
});
it('reads the error code and identifies the SDK', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ error: 'Private.', code: 'NOT_ADMITTED' }, { status: 403 }));
  await expect(client().account()).rejects.toMatchObject({ status: 403, code: 'NOT_ADMITTED' });
  expect(new Headers(fetch.mock.calls[0][1]?.headers).get('User-Agent')).toBe(
    `herald-sdk-ts/${version}`,
  );
  expect(new Herald({ userAgent: 'herald-cli/1' }).userAgent).toBe('herald-cli/1');
});
it('calls the token and ping endpoints', async () => {
  const seen: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = new URL(String(url));
    seen.push(`${init?.method || 'GET'} ${target.pathname}`);
    if (target.pathname === '/api/ping')
      return Response.json({ ok: true, channel: 'production', version: '1' });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ id: 't', name: 'CI' });
  });
  const herald = client();
  expect((await herald.ping()).channel).toBe('production');
  expect((await herald.token()).name).toBe('CI');
  expect(await herald.revokeToken()).toBeUndefined();
  expect(seen).toEqual(['GET /api/ping', 'GET /api/v1/token', 'DELETE /api/v1/token']);
});
it('streams downloads with the server-given file name', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('bytes', {
      headers: { 'Content-Disposition': "attachment; filename*=UTF-8''..%2Fr%C3%A9port.txt" },
    }),
  );
  const file = await client().download('f1');
  expect(file.name).toBe('réport.txt');
  expect(new TextDecoder().decode(await file.bytes())).toBe('bytes');
});
