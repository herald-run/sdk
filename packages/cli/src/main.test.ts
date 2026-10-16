import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Herald, version, type Message } from '@herald-run/sdk';
import contracts from '@herald-run/sdk/fixtures/contracts.json';
import { main, type Io } from './main';
let home = '';
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herald-cli-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});
type Seen = { method: string; url: URL; headers: Headers; body?: unknown };
/** Answers fetches from `routes` ("METHOD /path" → reply), recording each request. */
function server(routes: Record<string, (seen: Seen) => Response | Promise<Response>>) {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const text = init?.body ? await new Response(init.body).text() : undefined;
    const body =
      text && headers.get('Content-Type') === 'application/json' ? JSON.parse(text) : text;
    const request = { method: init?.method || 'GET', url, headers, body };
    seen.push(request);
    const route = routes[`${request.method} ${url.pathname}`];
    return route ? route(request) : Response.json({ error: 'Not found.' }, { status: 404 });
  });
  return seen;
}
async function run(argv: string[], env: Record<string, string> = { HERALD_TOKEN: 'hdr_test' }) {
  const out: string[] = [],
    err: string[] = [],
    raw: string[] = [];
  const io: Io = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    write: (chunk) => raw.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()),
    env: { HERALD_URL: 'https://herald.test', ...env },
    home,
    open: () => false,
  };
  const code = await main(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n'), raw: raw.join('') };
}
const message = (extra: object = {}) => ({
  id: 'm1',
  title: 'Deploy?',
  status: 'pending',
  kind: 'form',
  ...extra,
});

it('prints the version, help and usage errors with documented exit codes', async () => {
  expect(await run(['--version'])).toMatchObject({ code: 0, out: version });
  const help = await run([]);
  expect(help.code).toBe(0);
  expect(help.out.startsWith('Herald\n')).toBe(true);
  expect((await run(['help', 'send'])).out).toContain('--file PATH');
  expect((await run(['ask', '--help'])).out).toContain('Usage: herald ask');
  expect((await run(['get', '--help'])).out).toContain('Usage: herald show');
  expect(await run(['nope'])).toMatchObject({ code: 2, err: expect.stringContaining('Unknown') });
  expect((await run(['help', 'nope'])).code).toBe(2);
  expect((await run(['send', '--bogus'])).code).toBe(2);
  expect((await run(['whoami', '--title', 'x'])).code).toBe(2);
  expect((await run(['show'])).code).toBe(2);
  expect((await run(['completion', 'bash'])).out).toContain('complete -o default -F _herald');
  expect((await run(['completion', 'fish'])).out).toContain('-a listen');
  expect((await run(['completion', 'tcsh'])).code).toBe(2);
});
it('sends human-readable by default, JSON with --json, and identifies itself', async () => {
  const seen = server({ 'POST /api/v1/messages': () => Response.json(message(), { status: 201 }) });
  expect(await run(['send', '--title', 'Hi', '--body', 'There'])).toMatchObject({
    code: 0,
    out: 'm1',
  });
  expect(seen[0].body).toEqual({ title: 'Hi', body: 'There', kind: 'message', fields: [] });
  expect(seen[0].headers.get('User-Agent')).toBe(`herald-cli/${version}`);
  expect(seen[0].headers.get('Authorization')).toBe('Bearer hdr_test');
  expect(JSON.parse((await run(['send', '--json', '--title', 'Hi'])).out)).toEqual(message());
});
it('reserves, uploads and attaches every --file in one send', async () => {
  const files = [join(home, 'a.png'), join(home, 'b.txt')];
  await writeFile(files[0], 'png');
  await writeFile(files[1], 'text!');
  let n = 0;
  const seen = server({
    'POST /api/v1/files': ({ body }) =>
      Response.json({ id: `f${++n}`, ...(body as object) }, { status: 201 }),
    'PUT /api/v1/files/f1': () => Response.json({ ok: true }),
    'PUT /api/v1/files/f2': () => Response.json({ ok: true }),
    'POST /api/v1/messages': () => Response.json(message(), { status: 201 }),
  });
  const result = await run(['send', '--title', 'Report', '--file', files[0], '--file', files[1]]);
  expect(result.code).toBe(0);
  expect(seen.map((s) => `${s.method} ${s.url.pathname}`)).toEqual([
    'POST /api/v1/files',
    'PUT /api/v1/files/f1',
    'POST /api/v1/files',
    'PUT /api/v1/files/f2',
    'POST /api/v1/messages',
  ]);
  expect(seen[1].body).toBe('png');
  expect((seen[4].body as { attachments: unknown[] }).attachments).toEqual([
    { id: 'f1', name: 'a.png', size: 3, type: 'image/png' },
    { id: 'f2', name: 'b.txt', size: 5, type: 'text/plain' },
  ]);
});
it.each([
  ['answered', 0],
  ['expired', 3],
  ['cancelled', 4],
])('ask exits by outcome: %s → %i', async (status, code) => {
  server({ 'POST /api/v1/messages': () => Response.json(message(), { status: 201 }) });
  const wait = vi.spyOn(Herald.prototype, 'wait').mockResolvedValue(
    message({
      status,
      response: status === 'answered' ? { values: { reply: 'Ship it' } } : undefined,
    }) as never,
  );
  const result = await run(['ask', '--title', 'Deploy?', '--timeout', '10m']);
  expect(result.code).toBe(code);
  expect(wait).toHaveBeenCalledWith('m1', { waitTimeout: 600 });
  if (status === 'answered') expect(result.out).toBe('reply  Ship it');
  else expect(result.err).toContain(`Request ${status}`);
  expect((await run(['wait', 'm1'])).code).toBe(code);
});
it('exits 1 with the server error and message ID', async () => {
  server({ 'POST /api/v1/messages': () => Response.json({ error: 'Nope.' }, { status: 403 }) });
  expect(await run(['send', '--title', 'x'])).toMatchObject({ code: 1, err: 'Nope.' });
  vi.spyOn(Herald.prototype, 'wait').mockRejectedValue(
    Object.assign(new Error('Wait timed out.'), { messageId: 'm1' }),
  );
  expect((await run(['wait', 'm1'])).code).toBe(1);
});
it('shows token, account and server status', async () => {
  const token = {
    id: 't1',
    name: 'Laptop',
    scopes: ['messages:send'],
    createdAt: '2026-01-01T00:00:00Z',
    lastUsedAt: null,
    account: { email: 'me@example.com', name: 'Me' },
  };
  const account = {
    id: 'u',
    name: 'Me',
    email: 'me@example.com',
    plan: 'free',
    used: 3,
    storage: 0,
    renewsAt: '2026-11-01T00:00:00Z',
  };
  const seen = server({
    'GET /api/v1/token': () => Response.json(token),
    'GET /api/v1/account': () => Response.json(account),
    'GET /api/ping': () => Response.json({ ok: true, channel: 'staging', version: '1.2.3' }),
  });
  const whoami = await run(['whoami']);
  expect(whoami.out).toContain('Laptop (t1)');
  expect(whoami.out).toContain('Me <me@example.com>');
  expect(whoami.out).toContain('End-to-end encryption: off');
  expect(JSON.parse((await run(['whoami', '--json'])).out)).toEqual({
    token,
    account,
    e2ee: { enabled: false },
  });
  const status = await run(['status']);
  expect(status).toMatchObject({ code: 0, out: expect.stringContaining('1.2.3 (staging)') });
  expect(seen.some((s) => s.url.pathname === '/api/ping')).toBe(true);
  expect((await run(['status'], {})).code).toBe(1);
  expect((await run(['account'])).out).toContain('resets   2026-11-01');
});
it('keeps tokens per profile and server, reading the original config for the default', async () => {
  const directory = join(home, '.config', 'herald');
  await mkdir(join(directory, 'profiles', 'work'), { recursive: true });
  await writeFile(join(directory, 'herald.test.json'), JSON.stringify({ token: 'hdr_default' }));
  await writeFile(
    join(directory, 'profiles', 'work', 'work.test.json'),
    JSON.stringify({ token: 'hdr_work' }),
  );
  await writeFile(
    join(directory, 'profiles.json'),
    JSON.stringify({ work: { url: 'https://work.test' } }),
  );
  const seen = server({ 'GET /api/v1/account': () => Response.json({ plan: 'free' }) });
  await run(['account'], {});
  await run(['account', '--profile', 'work'], { HERALD_URL: '' });
  await run(['account'], { HERALD_PROFILE: 'work', HERALD_URL: '' });
  expect(seen.map((s) => [s.url.host, s.headers.get('Authorization')])).toEqual([
    ['herald.test', 'Bearer hdr_default'],
    ['work.test', 'Bearer hdr_work'],
    ['work.test', 'Bearer hdr_work'],
  ]);
  expect((await run(['account', '--profile', '../x'])).code).toBe(1);
});
it('logout revokes the token on the server, then deletes it locally', async () => {
  const directory = join(home, '.config', 'herald');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'herald.test.json');
  await writeFile(path, JSON.stringify({ token: 'hdr_saved' }));
  const seen = server({ 'DELETE /api/v1/token': () => new Response(null, { status: 204 }) });
  expect((await run(['logout'], {})).code).toBe(0);
  expect(seen[0].headers.get('Authorization')).toBe('Bearer hdr_saved');
  await expect(stat(path)).rejects.toThrow();
  await writeFile(path, JSON.stringify({ token: 'hdr_saved' }));
  server({ 'DELETE /api/v1/token': () => Response.json({ error: 'Down.' }, { status: 503 }) });
  const failed = await run(['logout'], {});
  expect(failed.err).toContain('Could not revoke');
  await expect(stat(path)).rejects.toThrow();
});
it('lists, searches, shows messages and prints task logs', async () => {
  const seen = server({
    'GET /api/v1/messages': () => Response.json([message()]),
    'GET /api/v1/messages/m1': () =>
      Response.json(
        message({ status: 'answered', body: 'Body', response: { values: { ok: true } } }),
      ),
    'GET /api/v1/messages/t1/logs': () =>
      Response.json({ logs: [{ sequence: 3, stream: 'stdout', text: 'built\n' }] }),
  });
  expect((await run(['search', 'deploy', '--status', 'pending'])).out).toBe(
    'm1  pending  form  Deploy?',
  );
  expect(seen[0].url.search).toBe('?search=deploy&status=pending');
  const shown = (await run(['get', 'm1'])).out;
  expect(shown).toContain('status  answered');
  expect(shown).toContain('ok  true');
  expect((await run(['logs', 't1', '--after', '2'])).raw).toBe('built\n');
  expect(seen.at(-1)!.url.search).toBe('?after=2');
  expect((await run(['logs', 't1', '--after', '-1'])).code).toBe(2);
});
it('downloads to the server-given name without overwriting', async () => {
  server({
    'GET /api/v1/files/f1': () =>
      new Response('bytes', {
        headers: { 'Content-Disposition': "attachment; filename*=UTF-8''..%2Freport.txt" },
      }),
  });
  const out = join(home, 'saved.txt');
  expect((await run(['download', 'f1', '-o', out])).code).toBe(0);
  expect(await readFile(out, 'utf8')).toBe('bytes');
  const again = await run(['download', 'f1', '-o', out]);
  expect(again.code).toBe(1);
  expect(await readFile(out, 'utf8')).toBe('bytes');
  expect((await run(['download', 'f1', '-o', '-'])).raw).toBe('bytes');
});
it('manages destinations', async () => {
  const destination = { id: 'd1', key: 'laptop', name: 'Runner', integrationId: 'i' };
  const input = join(home, 'destination.json');
  await writeFile(input, JSON.stringify({ key: 'laptop', types: [] }));
  const seen = server({
    'GET /api/v1/destinations': () => Response.json([destination]),
    'PUT /api/v1/destinations/d1': () => Response.json(destination),
    'DELETE /api/v1/destinations/d1': () => Response.json({ ok: true }),
    'POST /api/v1/destinations/d1/secret': () =>
      Response.json({ ...destination, signingSecret: 'abc' }),
  });
  expect((await run(['destinations'])).out).toBe('d1  laptop  pull  Runner');
  expect((await run(['destinations', 'update', 'd1', '-i', input])).code).toBe(0);
  expect(seen.at(-1)!.body).toEqual({ key: 'laptop', types: [] });
  expect((await run(['destinations', 'rotate-secret', 'd1'])).out).toBe('abc');
  expect((await run(['destinations', 'remove', 'd1'])).out).toBe('Removed d1.');
  expect((await run(['destinations', 'explode'])).code).toBe(2);
});
it('keeps secret command failures to the fixed message', async () => {
  const result = await run(['send-secret', '--input', '/nonexistent', '--body', 'leak']);
  expect(result).toMatchObject({ code: 2, err: expect.stringContaining('Secret transfer failed') });
  expect(result.err).not.toContain('leak');
});
it('uses a stored keyed login: safety code, local search and encrypted secrets', async () => {
  const { token, steps } = contracts.e2ee;
  const body = (name: string) => steps.find((s) => s.name === name)!.response.body as Message;
  const [auth, seed, fingerprint] = token.split('.');
  const directory = join(home, '.config', 'herald');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'herald.test.json'),
    JSON.stringify({ token: auth, seed, fingerprint }),
  );
  const form = body('send-secret-form');
  const seen = server({
    'GET /api/v1/keys': () => Response.json(body('keys')),
    'GET /api/v1/token': () => Response.json({ name: 'Laptop', scopes: [], account: {} }),
    'GET /api/v1/account': () => Response.json({ name: 'Me', email: 'me@example.com' }),
    'GET /api/v1/messages': (s: Seen) =>
      Response.json(s.url.searchParams.has('before') ? [] : [body('get'), body('get-locked')]),
    'POST /api/v1/messages': () => Response.json(form),
    [`POST /api/v1/messages/${form.id}/secrets`]: () => Response.json(body('collect-secrets')),
  });
  vi.spyOn(Herald.prototype, 'wait').mockResolvedValue({ ...form, status: 'answered' } as never);
  expect((await run(['whoami'], {})).out).toContain(
    `End-to-end encryption: on (safety code ${fingerprint.match(/.{1,4}/g)!.join(' ')})`,
  );
  const found = JSON.parse((await run(['search', 'deploy v2', '--json'], {})).out);
  expect(found.map((m: { title: string }) => m.title)).toEqual(['Deploy v2?']);
  const out = join(home, 'secret.txt');
  expect((await run(['request-secret', '--out', out], {})).code).toBe(0);
  expect(await readFile(out, 'utf8')).toBe('test-only-token');
  const sent = seen.find((s) => s.method === 'POST' && s.url.pathname === '/api/v1/messages');
  expect(sent?.body).not.toHaveProperty('publicKey');
  expect(seen.every((s) => s.headers.get('Authorization') === `Bearer ${auth}`)).toBe(true);
  expect(seen.some((s) => s.url.search.includes('search'))).toBe(false);
});
