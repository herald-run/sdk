import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createServer as http } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { seal } from '@herald-run/sdk/crypto';
import { connect } from './auth';
import { createServer } from './server';

const canary = 'test-only-secret-value';
type Seen = { method: string; url: string; auth?: string; body: string };
let seen: Seen[] = [];
let answer: Record<string, unknown> = { status: 'answered', response: { values: { reply: 'ok' } } };
let key: JsonWebKey;
const server = http(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
  const input = body && req.headers['content-type']?.includes('json') ? JSON.parse(body) : {};
  res.setHeader('Content-Type', 'application/json');
  let result: unknown = {};
  if (req.url === '/api/v1/files' && req.method === 'POST')
    result = { ...input, id: '00000000-0000-4000-8000-000000000001' };
  else if (req.url === '/api/v1/messages' && req.method === 'POST') {
    key = input.publicKey;
    result = { ...input, id: 'm1', status: 'pending' };
  } else if (req.url === '/api/v1/messages/m1') result = { id: 'm1', title: 'Q', ...answer };
  else if (req.url?.startsWith('/api/v1/messages?'))
    result = [{ id: 'm1', title: 'Q', status: 'pending', direction: 'inbound', kind: 'form' }];
  else if (req.url === '/api/v1/messages/m1/secrets') result = { secret: await seal(canary, key) };
  res.end(JSON.stringify(result));
});
let folder: string, base: string, client: Client;
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'herald-mcp-'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const env = { HERALD_URL: base, HERALD_API_KEY: 'hdr_test' };
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
  answer = { status: 'answered', response: { values: { reply: 'ok' } } };
});
const call = async (name: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const text = result.content[0].text;
  return { text, error: !!result.isError, data: result.isError ? undefined : JSON.parse(text) };
};
const posted = () => JSON.parse(seen.find((s) => s.url === '/api/v1/messages')!.body);

it('lists every tool with a description', async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(
    [
      'ask',
      'cancel',
      'download_file',
      'get_message',
      'list_messages',
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
  expect(result.data).toEqual({ id: 'm1', status: 'pending' });
  expect(seen[0].auth).toBe('Bearer hdr_test');
  expect(seen.map((s) => s.method + ' ' + s.url).slice(0, 2)).toEqual([
    'POST /api/v1/files',
    'PUT /api/v1/files/00000000-0000-4000-8000-000000000001',
  ]);
  expect(posted()).toMatchObject({ title: 'Done', body: '**ok**', kind: 'message' });
  expect(posted().attachments[0]).toMatchObject({ name: 'report.md', type: 'text/markdown' });
});

it('asks approval, choice and free-text questions', async () => {
  answer = { status: 'answered', response: { values: {}, actionId: 'approve' } };
  expect((await call('ask', { title: 'Deploy?', approval: true })).data).toMatchObject({
    status: 'answered',
    approved: true,
  });
  expect(posted().actions.map((a: { id: string }) => a.id)).toEqual(['approve', 'reject']);
  seen = [];
  answer = { status: 'answered', response: { values: {}, actionId: 'choice2' } };
  const choice = await call('ask', { title: 'Which?', choices: ['a', 'b'], deadline: '5m' });
  expect(choice.data.choice).toBe('b');
  expect(posted().expiresIn).toBe(300);
  seen = [];
  answer = { status: 'answered', response: { values: { reply: 'ok' } } };
  expect((await call('ask', { title: 'Notes?' })).data.values).toEqual({ reply: 'ok' });
  expect(posted().fields[0]).toMatchObject({ id: 'reply', type: 'textarea' });
  expect((await call('ask', { title: 'x', approval: true, choices: ['a', 'b'] })).error).toBe(true);
});

it('reports expired requests and lists summaries', async () => {
  answer = { status: 'expired' };
  expect((await call('wait', { id: 'm1' })).data).toMatchObject({ id: 'm1', status: 'expired' });
  const list = await call('list_messages', { status: 'pending' });
  expect(list.data[0]).toMatchObject({ id: 'm1', status: 'pending' });
  expect(seen.at(-1)!.url).toContain('status=pending');
});

it('stores a requested secret in a 0600 file without returning it', async () => {
  const path = join(folder, 'token');
  const result = await call('request_secret', { path, label: 'API token' });
  expect(result.data).toMatchObject({ id: 'm1', status: 'stored', path });
  expect(await readFile(path, 'utf8')).toBe(canary);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(result.text).not.toContain(canary);
  const again = await call('request_secret', { path });
  expect(again.error).toBe(true);
  expect(again.text).not.toContain(canary);
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
  await writeFile(join(home, '.config', 'herald', '127.0.0.1.json'), '{"token":"hdr_saved"}');
  await other.callTool({ name: 'get_message', arguments: { id: 'm1' } });
  expect(seen.at(-1)!.auth).toBe('Bearer hdr_saved');
  await other.close();
});
