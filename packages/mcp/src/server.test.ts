import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createServer as http } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import contracts from '@herald-run/sdk/fixtures/contracts.json';
import type { Message } from '@herald-run/sdk/schema';
import * as sealed from '../../sdk/fixtures/sealed';
import { connect } from './auth';
import { createServer } from './server';

const canary = 'test-only-secret-value';
const step = (name: string) => contracts.e2ee.steps.find((s) => s.name === name)!.response.body;
const [locked, opened] = [step('get-locked'), step('get')] as { id: string }[];
type Seen = { method: string; url: string; auth?: string; body: string };
type Answer = { status: string; values?: Record<string, unknown>; actionId?: string };
let seen: Seen[] = [];
let answer: Answer = { status: 'answered', values: { reply: 'ok' } };
/** The last request this connection sent. */
let request: Message;
const server = http(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
  const input = body && req.headers['content-type']?.includes('json') ? JSON.parse(body) : {};
  res.setHeader('Content-Type', 'application/json');
  let result: unknown = {};
  if (req.url === '/api/v1/files' && req.method === 'POST')
    result = { ...input, id: '00000000-0000-4000-8000-000000000001' };
  else if (req.url === '/api/v1/messages' && req.method === 'POST')
    result = request = sealed.stored(input);
  else if (req.url === `/api/v1/messages/${request?.id}`)
    result =
      answer.status === 'answered'
        ? await sealed.sealedAnswer(request, answer.values || {}, {
            actionId: answer.actionId,
            secretFields: answer.values ? [] : ['secret'],
          })
        : { ...request, status: answer.status };
  else if (req.url?.startsWith('/api/v1/messages?'))
    result = [await sealed.sealedMessage({ title: 'Q' }, { id: request.id, status: 'pending' })];
  else if (req.url === '/api/v1/keys') result = sealed.directory;
  else if (req.url === `/api/v1/messages/${locked.id}`) result = locked;
  else if (req.url === `/api/v1/messages/${opened.id}`) result = opened;
  else if (req.url === `/api/v1/messages/${request?.id}/secrets`)
    result = { secret: await sealed.sealedSecret(request.id, 'secret', canary) };
  res.end(JSON.stringify(result));
});
let folder: string, base: string, client: Client;
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'herald-mcp-'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const env = { HERALD_URL: base, HERALD_API_KEY: sealed.token };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(() => connect(env, folder)).connect(a);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
});
afterAll(async () => {
  await client.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(folder, { recursive: true, force: true });
});
beforeEach(() => {
  seen = [];
  answer = { status: 'answered', values: { reply: 'ok' } };
});
const last = (match: (s: Seen) => boolean) => seen.filter(match).at(-1);
const call = async (name: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const text = result.content[0].text;
  return { text, error: !!result.isError, data: result.isError ? undefined : JSON.parse(text) };
};
/** The content of the last message sent. */
const posted = async () =>
  sealed.opened(JSON.parse(last((s) => s.url === '/api/v1/messages')!.body).sealed);

it('lists every tool with a description', async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(
    [
      'ask',
      'cancel',
      'download_file',
      'get_message',
      'list_messages',
      'request_file',
      'request_secret',
      'send',
      'send_secret',
      'thread',
      'upload_file',
      'wait',
    ].sort(),
  );
  for (const tool of tools) expect(tool.description!.length).toBeGreaterThan(40);
});

it('sends markdown with uploaded files', async () => {
  const path = join(folder, 'report.md');
  await writeFile(path, '# Report');
  const result = await call('send', { title: 'Done', body: '**ok**', files: [path] });
  expect(result.data).toEqual({ id: request.id, status: 'delivered' });
  expect(seen.every((s) => s.auth === `Bearer ${sealed.auth}`)).toBe(true);
  expect(seen.map((s) => s.method + ' ' + s.url).filter((s) => s.includes('files'))).toEqual([
    'POST /api/v1/files',
    'PUT /api/v1/files/00000000-0000-4000-8000-000000000001',
  ]);
  const content = await posted();
  expect(content).toMatchObject({ title: 'Done', body: '**ok**', kind: 'message' });
  expect((content.attachments as object[])[0]).toMatchObject({
    name: 'report.md',
    type: 'text/markdown',
  });
});

it('asks approval, choice and free-text questions', async () => {
  answer = { status: 'answered', values: {}, actionId: 'approve' };
  expect((await call('ask', { title: 'Deploy?', approval: true })).data).toMatchObject({
    status: 'answered',
    approved: true,
  });
  const { actions } = (await posted()) as { actions: { id: string }[] };
  expect(actions.map((a) => a.id)).toEqual(['approve', 'reject']);
  answer = { status: 'answered', values: {}, actionId: 'choice2' };
  const choice = await call('ask', { title: 'Which?', choices: ['a', 'b'], deadline: '5m' });
  expect(choice.data.choice).toBe('b');
  expect(JSON.parse(last((s) => s.url === '/api/v1/messages')!.body).expiresIn).toBe(300);
  answer = { status: 'answered', values: { reply: 'ok' } };
  expect((await call('ask', { title: 'Notes?' })).data.values).toEqual({ reply: 'ok' });
  const { fields } = (await posted()) as { fields: object[] };
  expect(fields[0]).toMatchObject({ id: 'reply', type: 'textarea' });
  expect((await call('ask', { title: 'x', approval: true, choices: ['a', 'b'] })).error).toBe(true);
});

it('asks multiple-choice questions and returns answers by question', async () => {
  const questions = [
    { question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres', preview: '`pg`' }] },
    { question: 'Checks?', options: [{ label: 'Lint' }, { label: 'Types' }], multiSelect: true },
  ];
  answer = { status: 'answered', values: { q1: 'MySQL', q2: ['Lint', 'Types'] } };
  const result = await call('ask', { title: 'Setup', questions });
  expect(result.data.answers).toEqual({ 'Which DB?': 'MySQL', 'Checks?': 'Lint, Types' });
  const { fields } = (await posted()) as { fields: object[] };
  expect(fields).toMatchObject([
    { id: 'q1', header: 'DB', type: 'select', other: true },
    { id: 'q2', type: 'multiselect', other: true },
  ]);
  expect((await call('ask', { title: 'x', questions, approval: true })).error).toBe(true);
});

it('reports expired requests and lists summaries', async () => {
  await call('send', { title: 'Q' });
  answer = { status: 'expired' };
  const { id } = request;
  expect((await call('wait', { id })).data).toMatchObject({ id, status: 'expired' });
  const list = await call('list_messages', { status: 'pending' });
  expect(list.data[0]).toMatchObject({ id, title: 'Q', status: 'pending' });
  expect(seen.some((s) => s.url.includes('status=pending'))).toBe(true);
});

it('stores a requested secret in a 0600 file without returning it', async () => {
  answer = { status: 'answered' };
  const path = join(folder, 'token');
  const result = await call('request_secret', { path, label: 'API token' });
  expect(result.data).toMatchObject({ id: request.id, status: 'stored', path });
  expect(await readFile(path, 'utf8')).toBe(canary);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(result.text).not.toContain(canary);
  const again = await call('request_secret', { path });
  expect(again.error).toBe(true);
  expect(again.text).not.toContain(canary);
});

it('fails a file request with fixed text and leaves no file', async () => {
  answer = { status: 'answered' };
  const path = join(folder, 'requested');
  const result = await call('request_file', { path, label: 'Kubeconfig' });
  expect(result).toMatchObject({ error: true, text: expect.stringContaining('File transfer') });
  expect(await stat(path).catch(() => null)).toBeNull();
});

it('uses the CLI login when no token is set, and explains when there is none', async () => {
  const home = join(folder, 'home');
  const empty = createServer(() => connect({ HERALD_URL: base }, home));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await empty.connect(a);
  const other = new Client({ name: 'test', version: '1' });
  await other.connect(b);
  const missing = (await other.callTool({ name: 'get_message', arguments: { id: 'm1' } })) as {
    content: { text: string }[];
  };
  expect(missing.content[0].text).toContain('herald-run/cli login');
  await mkdir(join(home, '.config', 'herald'), { recursive: true });
  // A saved login without an end-to-end key is refused before any request.
  await writeFile(join(home, '.config', 'herald', '127.0.0.1.json'), '{"token":"hdr_saved"}');
  seen = [];
  const unkeyed = (await other.callTool({ name: 'get_message', arguments: { id: 'm1' } })) as {
    content: { text: string }[];
  };
  expect(unkeyed.content[0].text).toContain('Run herald login again');
  expect(seen).toEqual([]);
  await other.close();
});

it('uses a keyed CLI login and reports locked records plainly', async () => {
  const home = join(folder, 'keyed');
  const [auth, seed, fingerprint] = contracts.e2ee.token.split('.');
  await mkdir(join(home, '.config', 'herald'), { recursive: true });
  const saved = JSON.stringify({ token: auth, seed, fingerprint });
  await writeFile(join(home, '.config', 'herald', '127.0.0.1.json'), saved);
  const keyed = createServer(() => connect({ HERALD_URL: base }, home));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await keyed.connect(a);
  const other = new Client({ name: 'test', version: '1' });
  await other.connect(b);
  const get = async (id: string) => {
    const result = (await other.callTool({ name: 'get_message', arguments: { id } })) as {
      content: { text: string }[];
    };
    return JSON.parse(result.content[0].text);
  };
  expect(await get(opened.id)).toMatchObject({ title: 'Deploy v2?', e2ee: true });
  expect(await get(locked.id)).toMatchObject({ title: 'Encrypted message', locked: true });
  expect(seen.every((s) => s.auth === `Bearer ${auth}`)).toBe(true);
  await other.close();
});
