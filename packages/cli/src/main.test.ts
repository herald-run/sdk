import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Herald, HeraldError, version, type Message } from '@herald-run/sdk';
import * as e2ee from '@herald-run/sdk/e2ee';
import contracts from '@herald-run/sdk/fixtures/contracts.json';
import * as sealed from '../../sdk/fixtures/sealed';
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
  routes = { 'GET /api/v1/keys': () => Response.json(sealed.directory), ...routes };
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
async function run(
  argv: string[],
  env: Record<string, string> = { HERALD_TOKEN: sealed.token },
  stdin?: string,
) {
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
    stdin: stdin === undefined ? undefined : async () => stdin,
  };
  const code = await main(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n'), raw: raw.join('') };
}
const last = (seen: Seen[], match: (s: Seen) => boolean) => seen.filter(match).at(-1);
const [M1, T1] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const content = { title: 'Deploy?', kind: 'form' };
const message = (extra: Partial<Message> = {}, more: object = {}) =>
  sealed.sealedMessage({ ...content, ...more }, { id: M1, ...extra });
/** The content of the last sealed request body. */
const sent = async (seen: Seen[], path = '/api/v1/messages') =>
  sealed.opened(
    (
      last(seen, (s) => s.method === 'POST' && s.url.pathname === path)!.body as never as {
        sealed: never;
      }
    ).sealed,
  );
/** A stored login for `auth` with the fixture key. */
const login = (auth: string) => {
  const { seed, fingerprint } = e2ee.parseToken(sealed.token);
  return JSON.stringify({ token: auth, seed, fingerprint });
};
const posted = (seen: Seen[]) => seen.filter((s) => s.url.pathname !== '/api/v1/keys');

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
  const record = await message();
  const seen = server({ 'POST /api/v1/messages': () => Response.json(record, { status: 201 }) });
  expect(await run(['send', '--title', 'Hi', '--body', 'There'])).toMatchObject({
    code: 0,
    out: M1,
  });
  expect(await sent(seen)).toMatchObject({ title: 'Hi', body: 'There', kind: 'message' });
  expect(seen[1].headers.get('User-Agent')).toBe(`herald-cli/${version}`);
  expect(seen[1].headers.get('Authorization')).toBe(`Bearer ${sealed.auth}`);
  expect(JSON.parse((await run(['send', '--json', '--title', 'Hi'])).out)).toMatchObject({
    id: M1,
    title: 'Deploy?',
    e2ee: true,
  });
});
it('reserves, uploads and attaches every --file in one send', async () => {
  const files = [join(home, 'a.png'), join(home, 'b.txt')];
  await writeFile(files[0], 'png');
  await writeFile(files[1], 'text!');
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  let n = 0;
  const record = await message();
  const seen = server({
    'POST /api/v1/files': ({ body }) =>
      Response.json({ id: ids[n++], ...(body as object) }, { status: 201 }),
    [`PUT /api/v1/files/${ids[0]}`]: () => Response.json({ ok: true }),
    [`PUT /api/v1/files/${ids[1]}`]: () => Response.json({ ok: true }),
    'POST /api/v1/messages': () => Response.json(record, { status: 201 }),
  });
  const result = await run(['send', '--title', 'Report', '--file', files[0], '--file', files[1]]);
  expect(result.code).toBe(0);
  expect(posted(seen).map((s) => `${s.method} ${s.url.pathname}`)).toEqual([
    'POST /api/v1/files',
    `PUT /api/v1/files/${ids[0]}`,
    'POST /api/v1/files',
    `PUT /api/v1/files/${ids[1]}`,
    'POST /api/v1/messages',
  ]);
  expect(posted(seen)[0].body).toEqual({
    name: 'encrypted',
    type: 'application/octet-stream',
    size: 26,
  });
  expect(posted(seen)[1].body).not.toContain('png');
  expect((await sent(seen)).attachments).toEqual([
    { id: ids[0], name: 'a.png', size: 3, type: 'image/png', key: expect.any(String) },
    { id: ids[1], name: 'b.txt', size: 5, type: 'text/plain', key: expect.any(String) },
  ]);
});
it.each([
  ['answered', 0],
  ['expired', 3],
  ['cancelled', 4],
])('ask exits by outcome: %s → %i', async (status, code) => {
  const record = await message();
  server({ 'POST /api/v1/messages': () => Response.json(record, { status: 201 }) });
  const wait = vi.spyOn(Herald.prototype, 'wait').mockResolvedValue({
    ...record,
    title: 'Deploy?',
    status,
    response:
      status === 'answered'
        ? { values: { reply: 'Ship it' }, secretFields: [], createdAt: record.createdAt }
        : undefined,
  } as never);
  const result = await run(['ask', '--title', 'Deploy?', '--timeout', '10m']);
  expect(result.code).toBe(code);
  expect(wait).toHaveBeenCalledWith(M1, { waitTimeout: 600 });
  if (status === 'answered') expect(result.out).toBe('reply  Ship it');
  else expect(result.err).toContain(`Request ${status}`);
  expect((await run(['wait', M1])).code).toBe(code);
});
it('asks -i questions and prints chosen and Other answers', async () => {
  const record = await message();
  const seen = server({ 'POST /api/v1/messages': () => Response.json(record, { status: 201 }) });
  const values = { q1: 'MySQL 8', q2: 'Sidebar', q3: ['Lint', 'e2e'] };
  vi.spyOn(Herald.prototype, 'wait').mockResolvedValue({
    ...record,
    status: 'answered',
    response: { values, secretFields: [], createdAt: record.createdAt },
  } as never);
  const input = new URL('../../../examples/questions.json', import.meta.url).pathname;
  const result = await run(['ask', '-i', input]);
  expect(result).toMatchObject({ code: 0, out: 'q1  MySQL 8\nq2  Sidebar\nq3  Lint, e2e' });
  const { fields } = (await sent(seen)) as { fields: { id: string; other?: boolean }[] };
  expect(fields.map((f) => f.id + (f.other ? '+other' : ''))).toEqual([
    'q1+other',
    'q2+other',
    'q3+other',
  ]);
});
it('exits 1 with the server error and message ID', async () => {
  server({ 'POST /api/v1/messages': () => Response.json({ error: 'Nope.' }, { status: 403 }) });
  expect(await run(['send', '--title', 'x'])).toMatchObject({ code: 1, err: 'Nope.' });
  vi.spyOn(Herald.prototype, 'wait').mockRejectedValue(
    Object.assign(new Error('Wait timed out.'), { messageId: M1 }),
  );
  expect((await run(['wait', M1])).code).toBe(1);
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
  expect(whoami.out.match(/^account .*$/gm)).toEqual(['account  Me <me@example.com>']);
  const code = e2ee.safetyCode(e2ee.parseToken(sealed.token).fingerprint!);
  expect(whoami.out).toContain(`End-to-end encryption: on (safety code ${code})`);
  expect(JSON.parse((await run(['whoami', '--json'])).out)).toEqual({
    token,
    account,
    e2ee: { enabled: true, safetyCode: code },
  });
  const status = await run(['status']);
  expect(status).toMatchObject({ code: 0, out: expect.stringContaining('1.2.3 (staging)') });
  expect(seen.some((s) => s.url.pathname === '/api/ping')).toBe(true);
  expect((await run(['status'], {})).code).toBe(1);
  // For token callers the account record's name is the connection's.
  const shown = (await run(['account'])).out;
  expect(shown).toMatch(/^account +Me <me@example.com>$/m);
  expect(shown).toMatch(/^connection +Me$/m);
  expect(shown).toMatch(/^resets +2026-11-01$/m);
});
it('keeps tokens per profile and server, reading the original config for the default', async () => {
  const directory = join(home, '.config', 'herald');
  await mkdir(join(directory, 'profiles', 'work'), { recursive: true });
  await writeFile(join(directory, 'herald.test.json'), login('hdr_default'));
  await writeFile(join(directory, 'profiles', 'work', 'work.test.json'), login('hdr_work'));
  await writeFile(
    join(directory, 'profiles.json'),
    JSON.stringify({ work: { url: 'https://work.test' } }),
  );
  const seen = server({
    'GET /api/v1/account': () => Response.json({ plan: 'free' }),
    'GET /api/v1/token': () => Response.json({ account: { email: 'me@example.com' } }),
  });
  await run(['account'], {});
  await run(['account', '--profile', 'work'], { HERALD_URL: '' });
  await run(['account'], { HERALD_PROFILE: 'work', HERALD_URL: '' });
  await writeFile(join(directory, 'herald.test.json'), JSON.stringify({ token: 'hdr_old' }));
  expect((await run(['account'], {})).err).toContain('Run herald login again');
  const accounts = seen.filter((s) => s.url.pathname === '/api/v1/account');
  expect(accounts.map((s) => [s.url.host, s.headers.get('Authorization')])).toEqual([
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
  await writeFile(path, login('hdr_saved'));
  const seen = server({ 'DELETE /api/v1/token': () => new Response(null, { status: 204 }) });
  expect((await run(['logout'], {})).code).toBe(0);
  expect(seen[0].headers.get('Authorization')).toBe('Bearer hdr_saved');
  await expect(stat(path)).rejects.toThrow();
  await writeFile(path, JSON.stringify({ token: 'hdr_saved' }));
  expect((await run(['logout'], {})).err).toContain('Revoke the connection in Settings');
  await expect(stat(path)).rejects.toThrow();
  await writeFile(path, login('hdr_saved'));
  server({ 'DELETE /api/v1/token': () => Response.json({ error: 'Down.' }, { status: 503 }) });
  const failed = await run(['logout'], {});
  expect(failed.err).toContain('Could not revoke');
  await expect(stat(path)).rejects.toThrow();
});
it('lists, searches, shows messages and prints task logs', async () => {
  const list = [await message(), await message({ id: crypto.randomUUID() }, { title: 'Other' })];
  const answered = await sealed.sealedAnswer(
    await message({}, { body: 'Body', fields: [{ id: 'ok', label: 'OK', type: 'boolean' }] }),
    { ok: true },
  );
  const task = await sealed.sealedTask({}, { id: T1 });
  const seen = server({
    'GET /api/v1/messages': (s) => Response.json(s.url.searchParams.has('before') ? [] : list),
    [`GET /api/v1/messages/${M1}`]: () => Response.json(answered),
    [`GET /api/v1/messages/${T1}`]: () => Response.json(task),
    [`GET /api/v1/messages/${T1}/logs`]: async () =>
      Response.json({ logs: [await sealed.sealedLog(T1, 3, 'built\n')] }),
  });
  expect((await run(['search', 'deploy', '--status', 'pending'])).out).toBe(
    `${M1}  pending  form  Deploy?`,
  );
  expect(posted(seen)[0].url.search).toBe('?status=pending');
  const shown = (await run(['get', M1])).out;
  expect(shown).toMatch(/status +answered/);
  expect(shown).toContain('ok  true');
  expect((await run(['logs', T1, '--after', '2'])).raw).toBe('built\n');
  expect(last(seen, (s) => s.url.pathname.endsWith('/logs'))!.url.search).toBe('?after=2');
  expect((await run(['logs', T1, '--after', '-1'])).code).toBe(2);
});
it('downloads and decrypts an attachment without overwriting', async () => {
  const id = crypto.randomUUID();
  const key = e2ee.fileKey();
  const file = { id, name: 'report.txt', type: 'text/plain', size: 5, key };
  const record = await message({}, { attachments: [file] });
  const bytes = await new Response(
    e2ee.sealFile(key, new TextEncoder().encode('bytes')),
  ).arrayBuffer();
  server({
    [`GET /api/v1/messages/${M1}`]: () => Response.json(record),
    [`GET /api/v1/files/${id}`]: () => new Response(bytes),
  });
  const out = join(home, 'saved.txt');
  expect((await run(['download', id, '--message', M1, '-o', out])).code).toBe(0);
  expect(await readFile(out, 'utf8')).toBe('bytes');
  const again = await run(['download', id, '--message', M1, '-o', out]);
  expect(again.code).toBe(1);
  expect(await readFile(out, 'utf8')).toBe('bytes');
  expect((await run(['download', id, '--message', M1, '-o', '-'])).raw).toBe('bytes');
  expect((await run(['download', id])).code).toBe(2);
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
  const result = await run(['send', '--secret-file', '/nonexistent', '--field', 'leak:text']);
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
  const fields = [{ id: 'secret', label: 'Token', type: 'secret', required: true }];
  const response = { values: {}, secretFields: ['secret'], createdAt: form.createdAt };
  vi.spyOn(Herald.prototype, 'wait').mockResolvedValue({
    ...form,
    fields,
    response,
    status: 'answered',
  } as never);
  expect((await run(['whoami'], {})).out).toContain(
    `End-to-end encryption: on (safety code ${e2ee.safetyCode(fingerprint)})`,
  );
  const found = JSON.parse((await run(['search', 'deploy v2', '--json'], {})).out);
  expect(found.map((m: { title: string }) => m.title)).toEqual(['Deploy v2?']);
  const out = join(home, 'secret.txt');
  const asked = await run(['ask', '--field', 'secret:secret:Token', '--out', out], {});
  expect(asked).toMatchObject({ code: 0, out: `secret  stored ${out}` });
  expect(await readFile(out, 'utf8')).toBe('test-only-token');
  const sent = seen.find((s) => s.method === 'POST' && s.url.pathname === '/api/v1/messages');
  expect(sent?.body).not.toHaveProperty('publicKey');
  expect(seen.every((s) => s.headers.get('Authorization') === `Bearer ${auth}`)).toBe(true);
  expect(seen.some((s) => s.url.search.includes('search'))).toBe(false);
});
it('removes the shortcut commands', async () => {
  for (const command of ['request-secret', 'request-file', 'send-secret', 'upload', 'integrate'])
    expect(await run([command])).toMatchObject({
      code: 2,
      err: expect.stringContaining('Unknown'),
    });
  expect((await run(['help'])).out).not.toContain('request-secret');
  expect((await run(['help', 'send'])).out).toContain('ID[?]:TYPE[:LABEL[:CHOICES]]');
});
it('composes forms, actions, blocks and review from flags, merged onto -i', async () => {
  const record = await message();
  const seen = server({ 'POST /api/v1/messages': () => Response.json(record, { status: 201 }) });
  const input = join(home, 'in.json');
  await writeFile(
    input,
    JSON.stringify({
      title: 'From file',
      body: 'old',
      fields: [{ id: 'note', label: 'Note', type: 'text' }],
      blocks: [{ type: 'diff', text: '-a\n+b' }],
    }),
  );
  const [code, csv] = [join(home, 'deploy.ts'), join(home, 't.csv')];
  await writeFile(code, 'let x = 1;');
  await writeFile(csv, 'name,"note, quoted"\napi,"say ""hi"""\n');
  const args = ['send', '-i', input, '--title', 'Deploy?', '--body-file', '-', '--review'];
  const fields = ['--field', 'env?:select:Environment:staging,prod=Production'];
  const blocks = ['--block', `code=${code}`, '--block', `table=${csv}`];
  const result = await run(
    [...args, ...fields, '--action', 'ship:Ship it', ...blocks],
    undefined,
    'Hi',
  );
  expect(result.code).toBe(0);
  expect(await sent(seen)).toMatchObject({
    title: 'Deploy?',
    body: 'Hi',
    kind: 'form',
    requiresReview: true,
    fields: [
      { id: 'note' },
      {
        id: 'env',
        type: 'select',
        label: 'Environment',
        required: false,
        options: [
          { value: 'staging', label: 'staging' },
          { value: 'prod', label: 'Production' },
        ],
      },
    ],
    actions: [{ id: 'ship', label: 'Ship it', values: {} }],
    blocks: [
      { type: 'diff', text: '-a\n+b' },
      { type: 'code', title: 'deploy.ts', language: 'typescript', text: 'let x = 1;' },
      {
        type: 'table',
        title: 't.csv',
        columns: ['name', 'note, quoted'],
        rows: [['api', 'say "hi"']],
      },
    ],
  });
});
it('refuses bad specs before sending, with usage exit codes', async () => {
  const seen = server({});
  const cases: [string[], string][] = [
    [['send', '--field', 'x:bogus'], 'TYPE one of'],
    [['send', '--block', 'video=x'], 'TYPE=PATH'],
    [['send', '--body', 'a', '--body-file', 'f'], 'not both'],
    [['ask', '--body-file', '-', '--block', 'code=-'], 'stdin'],
    [['ask', '--field', 't:secret'], 'Secret fields need --out: t'],
    [['send', '--field', 't:secret', '--action', 'go'], 'every field optional'],
    [['send', '--field', 't:secret', '--out', 'x'], '--out needs --wait'],
    [['send', '--kind', 'secret'], '--kind is'],
  ];
  for (const [argv, text] of cases)
    expect(await run(argv)).toMatchObject({ code: 2, err: expect.stringContaining(text) });
  expect(seen.some((s) => s.method === 'POST')).toBe(false);
});
it('uploads image block files once and points the blocks at them', async () => {
  const [shot, other] = [join(home, 'shot.png'), join(home, 'b.png')];
  await writeFile(shot, 'png');
  await writeFile(other, 'png2');
  const input = join(home, 'in.json');
  await writeFile(
    input,
    JSON.stringify({ title: 'Look', blocks: [{ type: 'image', file: shot }] }),
  );
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  let n = 0;
  const record = await message();
  const seen = server({
    'POST /api/v1/files': ({ body }) =>
      Response.json({ id: ids[n++], ...(body as object) }, { status: 201 }),
    [`PUT /api/v1/files/${ids[0]}`]: () => Response.json({ ok: true }),
    [`PUT /api/v1/files/${ids[1]}`]: () => Response.json({ ok: true }),
    'POST /api/v1/messages': () => Response.json(record, { status: 201 }),
  });
  const result = await run(['send', '-i', input, '--file', shot, '--block', `image=${other}`]);
  expect(result.code).toBe(0);
  expect(seen.filter((s) => s.url.pathname === '/api/v1/files')).toHaveLength(2);
  const content = await sent(seen);
  expect((content.attachments as { id: string }[]).map((a) => a.id)).toEqual(ids);
  expect(content.blocks).toEqual([
    { type: 'image', attachmentId: ids[0], alt: 'shot.png' },
    { type: 'image', attachmentId: ids[1], alt: 'b.png' },
  ]);
});
it('deletes outputs and cancels the request when collecting fails', async () => {
  const record = await message();
  const seen = server({
    'POST /api/v1/messages': () => Response.json(record, { status: 201 }),
    [`POST /api/v1/messages/${M1}/cancel`]: () => Response.json(record),
  });
  vi.spyOn(Herald.prototype, 'wait').mockRejectedValue(new Error('untrusted-detail'));
  const out = join(home, 'token');
  const result = await run(['ask', '--field', 'token:secret', '--out', out]);
  expect(result).toMatchObject({ code: 1, err: expect.stringContaining('Secret transfer failed') });
  expect(result.err).not.toContain('untrusted-detail');
  await expect(stat(out)).rejects.toThrow();
  expect(seen.some((s) => s.url.pathname.endsWith('/cancel'))).toBe(true);
  // An existing output fails before anything is sent.
  await writeFile(out, 'keep');
  const sends = seen.length;
  expect((await run(['ask', '--field', 'token:secret', '--out', out])).code).toBe(1);
  expect(seen.slice(sends).some((s) => s.method === 'POST')).toBe(false);
  expect(await readFile(out, 'utf8')).toBe('keep');
});
it('keeps a resumed request pending when wait --out times out', async () => {
  const asked = await message(
    {},
    { fields: [{ id: 'token', label: 'T', type: 'secret', required: true }] },
  );
  const seen = server({ [`GET /api/v1/messages/${M1}`]: () => Response.json(asked) });
  vi.spyOn(Herald.prototype, 'wait').mockRejectedValue(new HeraldError('Wait timed out', 408, M1));
  const out = join(home, 'token');
  const result = await run(['wait', M1, '--out', out]);
  expect(result).toMatchObject({ code: 1, err: `Timed out; ${M1} is still pending.` });
  await expect(stat(out)).rejects.toThrow();
  expect(seen.some((s) => s.url.pathname.endsWith('/cancel'))).toBe(false);
});
it('waits into a directory for several files and never shows uncollected secrets', async () => {
  const files = ['a.txt', '../a.txt'].map((name) => ({
    id: crypto.randomUUID(),
    name,
    type: 'text/plain',
    size: 1,
    key: e2ee.fileKey(),
  }));
  const fields = [
    { id: 'logs', label: 'Logs', type: 'file', required: true },
    { id: 'tok', label: 'Token', type: 'secret', required: false },
  ];
  const asked = await message({}, { fields });
  const answered = await sealed.sealedAnswer(
    asked,
    { logs: files.map((f) => f.id) },
    { attachments: files, secretFields: ['tok'] },
  );
  const routes: Record<string, () => Response | Promise<Response>> = {
    [`GET /api/v1/messages/${M1}`]: () => Response.json(answered),
    [`POST /api/v1/messages/${M1}/secrets`]: async () =>
      Response.json({ tok: await sealed.sealedSecret(M1, 'tok', 'test-only-value') }),
  };
  for (const file of files)
    routes[`GET /api/v1/files/${file.id}`] = async () =>
      new Response(
        await new Response(
          e2ee.sealFile(file.key, new TextEncoder().encode(file.name)),
        ).arrayBuffer(),
      );
  const seen = server(routes);
  vi.spyOn(Herald.prototype, 'wait').mockImplementation(function (this: Herald, id: string) {
    return this.get(id);
  });
  const shown = await run(['wait', M1]);
  expect(shown.out).toMatch(/^tok +not collected$/m);
  expect(seen.some((s) => s.url.pathname.endsWith('/secrets'))).toBe(false);
  const dir = join(home, 'logs');
  expect((await run(['wait', M1, '--out', `logs=${dir}`])).code).toBe(2);
  const tok = join(home, 'tok');
  const result = await run(['wait', M1, '--out', `logs=${dir}`, '--out', `tok=${tok}`, '--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).response.values).toEqual({
    logs: { stored: dir },
    tok: { stored: tok },
  });
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('a.txt');
  expect(await readFile(join(dir, '.._a.txt'), 'utf8')).toBe('../a.txt');
  expect(await readFile(tok, 'utf8')).toBe('test-only-value');
  expect((await stat(tok)).mode & 0o777).toBe(0o600);
  expect(result.out + result.err).not.toContain('test-only-value');
});
it('registers destinations from flags, each --field under the --type before it', async () => {
  const seen = server({
    'POST /api/v1/destinations': ({ body }) =>
      Response.json({ id: 'd1', name: 'Runner', integrationId: 'i', ...(body as object) }),
  });
  const result = await run([
    'register',
    '--target',
    'laptop',
    '--webhook',
    'https://hooks.test/h',
    '--description',
    'Runs deploys',
    '--type',
    'deploy:Deploy app',
    '--field',
    'env:select:Env:staging,prod',
    '--field',
    'note?:textarea',
    '--type',
    'ping',
  ]);
  expect(result).toMatchObject({ code: 0, out: 'd1  laptop  webhook  Runner' });
  expect(seen.at(-1)!.body).toMatchObject({
    key: 'laptop',
    transport: { kind: 'webhook', url: 'https://hooks.test/h' },
    description: 'Runs deploys',
    types: [
      {
        id: 'deploy',
        label: 'Deploy app',
        fields: [
          { id: 'env', type: 'select', required: true },
          { id: 'note', type: 'textarea', required: false },
        ],
      },
      { id: 'ping', label: 'Ping', fields: [] },
    ],
  });
  const input = join(home, 'destination.json');
  await writeFile(input, JSON.stringify({ key: 'old', types: [{ id: 'a', label: 'A' }] }));
  await run(['register', '-i', input, '--target', 'new', '--type', 'b']);
  expect(seen.at(-1)!.body).toMatchObject({ key: 'new', types: [{ id: 'a' }, { id: 'b' }] });
  for (const argv of [
    ['register'],
    ['register', '--field', 'x:text', '--type', 'a'],
    ['register', '--type', 'a', '--field', 'k:secret'],
  ])
    expect((await run(argv)).code).toBe(2);
});
it('uses a team workspace login: --team, answered by, whoami teams and the stored pin', async () => {
  const V = JSON.parse(
    await readFile(new URL('../../sdk/fixtures/e2ee-vectors.json', import.meta.url), 'utf8'),
  );
  const W = V.workspace;
  const integration = V.keySets.find((s: { name: string }) => s.name === 'integration');
  const directory = join(home, '.config', 'herald');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'herald.test.json');
  const stored = { token: 'hdr_ws', seed: integration.seed, fingerprint: W.fingerprint };
  await writeFile(file, JSON.stringify({ ...stored, workspace: W.workspace }));
  const [request, response] = W.envelopes;
  const base = contracts.e2ee.steps.find((s) => s.name === 'send')!.response.body as Message;
  const record = { ...base, id: request.ctx.id, team: 'team-ops', senderId: 'integration' };
  const answered = {
    ...record,
    sealed: request.envelope,
    status: 'answered',
    kind: 'form',
    answeredBy: 'user-ana',
    response: {
      values: {},
      secretFields: [],
      createdAt: base.createdAt,
      sealed: response.envelope,
    },
  };
  const certificates = W.certificates.map((c: { name: string; certificate: object }) => ({
    ...c.certificate,
    integrationId: c.name,
  }));
  const seen = server({
    'GET /api/v1/keys': () =>
      Response.json({
        account: null,
        certificates,
        workspace: { chain: W.chain, roster: W.roster },
      }),
    'GET /api/v1/token': () => Response.json({ name: 'Laptop', scopes: [], account: {} }),
    'GET /api/v1/account': () => Response.json({ name: 'Me', email: 'me@example.com' }),
    'POST /api/v1/messages': () => Response.json(answered),
    [`GET /api/v1/messages/${record.id}`]: () => Response.json(answered),
  });
  const who = await run(['whoami'], {});
  expect(who.out).toMatch(/workspace\s+ws_vectors \(roster epoch 2\)/);
  expect(who.out).toMatch(/teams\s+ops/);
  expect(JSON.parse(await readFile(file, 'utf8')).pin).toEqual(W.pin);
  expect((await run(['send', '--title', 'Restart?', '--team', 'ops'], {})).code).toBe(0);
  const post = last(seen, (s) => s.method === 'POST')!;
  expect(post.body).toMatchObject({ team: 'team-ops' });
  expect(post.headers.get('Herald-Workspace')).toBe(W.workspace);
  expect((await run(['show', record.id], {})).out).toMatch(/answered by\s+user-ana/);
  expect((await run(['send', '--title', 'x', '--team', 'all'], {})).err).toContain(
    'may not address team all',
  );
});
