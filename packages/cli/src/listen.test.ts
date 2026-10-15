import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Herald, HeraldError } from '@herald-run/sdk';
import type { Message } from '@herald-run/sdk/schema';
import { listen } from './listen';
const folders: string[] = [];
// A real client whose HTTP and watch are stubbed, so its task and destination methods are exercised.
const fake = (stubs: object) =>
  Object.assign(new Herald({ url: 'https://herald.test', apiKey: 'test-only' }), stubs);
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
it('persists completion and retries a lost outcome without rerunning the executable', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'herald-listener-'));
  folders.push(folder);
  const config = join(folder, 'runner.json'),
    file = join(folder, 'runs.txt'),
    destinationId = crypto.randomUUID();
  await writeFile(
    config,
    JSON.stringify({
      destinationId,
      command: process.execPath,
      args: [
        '-e',
        `let input='';process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{require('node:fs').appendFileSync(${JSON.stringify(file)},input);console.log('done');});`,
      ],
      cwd: folder,
    }),
  );
  const controller = new AbortController();
  const requests: Array<{ path: string; body: unknown }> = [];
  let reportFailed = false;
  const claimedElsewhere = crypto.randomUUID();
  let consume: ((message: Message) => Promise<void>) | undefined;
  const client = fake({
    async request(path: string, body: unknown) {
      requests.push({ path, body });
      if (path === '/destinations') return [{ id: destinationId }];
      if (path === `/tasks/${claimedElsewhere}/claim`)
        throw new HeraldError('Already claimed', 409);
      if (path.endsWith('/claim')) return { lease: 'lease' };
      if ((body as { status?: string })?.status === 'completed' && !reportFailed) {
        reportFailed = true;
        throw new TypeError('Connection lost');
      }
      return {};
    },
    watch(fn: (message: Message) => Promise<void>) {
      consume = fn;
      return () => {};
    },
  });
  const run = listen(client, config, 'test', folder, controller.signal);
  for (let i = 0; i < 100 && !consume; i++) await new Promise((r) => setTimeout(r, 10));
  expect(consume).toBeDefined();
  const message = {
    title: 'Task',
    body: '',
    fields: [],
    attachments: [{ id: 'sample-file', name: 'brief.txt', type: 'text/plain', size: 4 }],
    session: {
      prompt: 'literal $(do-not-run)',
      modes: { permission: 'ask' },
      command: { id: 'review', arguments: { base: 'main' } },
    },
    kind: 'message',
    sender: 'Runner',
    senderId: 'integration',
    createdAt: new Date().toISOString(),
    read: false,
    archived: false,
    id: crypto.randomUUID(),
    runId: 'run',
    replyTo: 'parent',
    threadId: 'thread',
    threadSequence: 2,
    direction: 'outbound',
    destinationId,
    status: 'queued',
    revision: 1,
    response: {
      values: { prompt: 'literal $(do-not-run)' },
      secretFields: [],
      createdAt: new Date().toISOString(),
    },
  } as Message;
  try {
    await expect(consume!(message)).rejects.toThrow('Connection lost');
    await consume!(message);
    await consume!({ ...message, id: claimedElsewhere });
  } finally {
    controller.abort();
    await run;
  }
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
    values: { prompt: 'literal $(do-not-run)' },
    replyTo: 'parent',
    threadId: 'thread',
    threadSequence: 2,
    session: message.session,
    attachments: message.attachments,
  });
  expect(requests.filter((r) => r.path.endsWith('/claim'))).toHaveLength(2);
  expect(
    requests.filter((r) => (r.body as { status?: string })?.status === 'completed'),
  ).toHaveLength(2);
  expect((await readdir(join(folder, 'runners'))).some((f) => f.endsWith('.lock'))).toBe(false);
});
it('retries rate-limited log batches with a stable key and never fails a task over logs', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'herald-listener-'));
  folders.push(folder);
  const config = join(folder, 'runner.json'),
    destinationId = crypto.randomUUID();
  await writeFile(
    config,
    JSON.stringify({
      destinationId,
      command: process.execPath,
      args: ['-e', `console.log('progress')`],
      cwd: folder,
    }),
  );
  const logPosts: Array<{ id: string; key?: string; sequence: number }> = [];
  const statuses: Record<string, string> = {};
  let consume: ((message: Message) => Promise<void>) | undefined;
  const client = fake({
    async request(
      path: string,
      body: Record<string, unknown>,
      options?: { idempotencyKey?: string },
    ) {
      if (path === '/destinations') return [{ id: destinationId }];
      if (path.endsWith('/claim')) return { lease: 'lease' };
      const id = path.split('/')[2];
      if (body.logs) {
        const sequence = (body.logs as Array<{ sequence: number }>)[0].sequence;
        logPosts.push({ id, key: options?.idempotencyKey, sequence });
        // 'limited' is rate limited once; 'broken*' never get their logs through.
        if (id === 'limited' && logPosts.filter((p) => p.id === id).length === 1)
          throw new HeraldError('Rate limited.', 429, undefined, 0);
        if (id.startsWith('broken')) throw new HeraldError('Unavailable.', 503, undefined, 0);
        return {};
      }
      statuses[id] = body.status as string;
      return {};
    },
    watch(fn: (message: Message) => Promise<void>) {
      consume = fn;
      return () => {};
    },
  });
  const controller = new AbortController();
  const run = listen(client, config, 'test', folder, controller.signal);
  for (let i = 0; i < 100 && !consume; i++) await new Promise((r) => setTimeout(r, 10));
  const task = (id: string) =>
    ({ id, direction: 'outbound', destinationId, status: 'queued', revision: 1 }) as Message;
  try {
    await consume!(task('limited'));
    await consume!(task('broken'));
    await consume!(task('broken-again'));
  } finally {
    controller.abort();
    await run;
  }
  expect(statuses).toEqual({
    limited: 'completed',
    broken: 'completed',
    'broken-again': 'completed',
  });
  const limited = logPosts.filter((p) => p.id === 'limited');
  expect(limited).toHaveLength(2);
  expect(limited[0].key).toBe('limited:logs:0');
  expect(limited[1].key).toBe(limited[0].key);
  expect(logPosts.filter((p) => p.id === 'broken')).toHaveLength(5);
  // Once delivery has failed, later batches try once instead of stalling the queue.
  expect(logPosts.filter((p) => p.id === 'broken-again')).toHaveLength(1);
});
it.each([
  ['stops a task whose lapsing lease was lost', '2026-01-01T00:05:00Z'],
  ['never heartbeats a lease that does not lapse', undefined],
])('%s', async (_name, leaseExpiresAt) => {
  const folder = await mkdtemp(join(tmpdir(), 'herald-listener-'));
  folders.push(folder);
  const config = join(folder, 'runner.json'),
    destinationId = crypto.randomUUID();
  await writeFile(
    config,
    JSON.stringify({
      destinationId,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 600)'],
      cwd: folder,
    }),
  );
  const paths: string[] = [];
  const reports: unknown[] = [];
  let consume: ((message: Message) => Promise<void>) | undefined;
  const client = fake({
    async request(path: string, body: Record<string, unknown>) {
      paths.push(path);
      if (path === '/destinations') return [{ id: destinationId }];
      if (path.endsWith('/claim')) return { lease: 'lease', leaseExpiresAt };
      if (path.endsWith('/heartbeat')) throw new HeraldError('Task is not running.', 409);
      if (body.status) reports.push(body);
      return {};
    },
    watch(fn: (message: Message) => Promise<void>) {
      consume = fn;
      return () => {};
    },
  });
  const controller = new AbortController();
  const run = listen(client, config, 'test', folder, controller.signal, 50);
  for (let i = 0; i < 100 && !consume; i++) await new Promise((r) => setTimeout(r, 10));
  try {
    await consume!({ id: 't', direction: 'outbound', destinationId, status: 'queued' } as Message);
  } finally {
    controller.abort();
    await run;
  }
  expect(paths.find((p) => p.endsWith('/claim'))).toBeDefined();
  if (leaseExpiresAt) {
    expect(reports).toEqual([{ lease: 'lease', status: 'failed', error: 'Task lease was lost.' }]);
  } else {
    expect(paths.some((p) => p.endsWith('/heartbeat'))).toBe(false);
    expect(reports).toEqual([{ lease: 'lease', status: 'completed' }]);
  }
});
it.each([
  [undefined, 1],
  [2, 2],
])('runs at most %s tasks at once (default 1)', async (concurrency, expected) => {
  const folder = await mkdtemp(join(tmpdir(), 'herald-listener-'));
  folders.push(folder);
  const config = join(folder, 'runner.json'),
    log = join(folder, 'log.txt'),
    destinationId = crypto.randomUUID();
  // Each run records how many runs are active when it starts.
  const script = `const fs=require('node:fs'),p=require('node:path');const d=${JSON.stringify(folder)}+'/active',f=p.join(d,String(process.pid));fs.mkdirSync(d,{recursive:true});fs.writeFileSync(f,'');fs.appendFileSync(${JSON.stringify(log)},fs.readdirSync(d).length+'\\n');setTimeout(()=>fs.rmSync(f),600);`;
  await writeFile(
    config,
    JSON.stringify({ destinationId, command: process.execPath, args: ['-e', script], cwd: folder }),
  );
  const statuses: Record<string, string> = {};
  let consume: ((message: Message) => Promise<void>) | undefined;
  const client = fake({
    async request(path: string, body: Record<string, unknown>) {
      if (path === '/destinations') return [{ id: destinationId }];
      if (path.endsWith('/claim')) return { lease: 'lease' };
      if (body.status) statuses[path.split('/')[2]] = body.status as string;
      return {};
    },
    watch(fn: (message: Message) => Promise<void>) {
      consume = fn;
      return () => {};
    },
  });
  const controller = new AbortController();
  const run = listen(client, config, 'test', folder, controller.signal, 60000, concurrency);
  for (let i = 0; i < 100 && !consume; i++) await new Promise((r) => setTimeout(r, 10));
  try {
    for (const [i, id] of ['a', 'b', 'c'].entries())
      await consume!({
        id,
        direction: 'outbound',
        destinationId,
        status: 'queued',
        revision: i + 1,
      } as Message);
    for (let i = 0; i < 300 && Object.keys(statuses).length < 3; i++)
      await new Promise((r) => setTimeout(r, 10));
  } finally {
    controller.abort();
    await run;
  }
  expect(statuses).toEqual({ a: 'completed', b: 'completed', c: 'completed' });
  const counts = (await readFile(log, 'utf8')).trim().split('\n').map(Number);
  expect(Math.max(...counts)).toBe(expected);
  const journal = (await readdir(join(folder, 'runners'))).find((f) => f.endsWith('.json'))!;
  expect(JSON.parse(await readFile(join(folder, 'runners', journal), 'utf8')).cursor).toBe(3);
});
it('keeps the cursor before a running task while later tasks finish', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'herald-listener-'));
  folders.push(folder);
  const config = join(folder, 'runner.json'),
    destinationId = crypto.randomUUID();
  const script = `setTimeout(()=>{},process.env.HERALD_TASK_ID==='slow'?800:0)`;
  await writeFile(
    config,
    JSON.stringify({ destinationId, command: process.execPath, args: ['-e', script], cwd: folder }),
  );
  const statuses: Record<string, string> = {};
  let consume: ((message: Message) => Promise<void>) | undefined;
  const client = fake({
    async request(path: string, body: Record<string, unknown>) {
      if (path === '/destinations') return [{ id: destinationId }];
      if (path.endsWith('/claim')) return { lease: 'lease' };
      if (body.status) statuses[path.split('/')[2]] = body.status as string;
      return {};
    },
    watch(fn: (message: Message) => Promise<void>) {
      consume = fn;
      return () => {};
    },
  });
  const controller = new AbortController();
  const run = listen(client, config, 'test', folder, controller.signal, 60000, 2);
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 300 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  const cursor = async () => {
    const dir = join(folder, 'runners');
    const file = (await readdir(dir)).find((f) => f.endsWith('.json'))!;
    return JSON.parse(await readFile(join(dir, file), 'utf8')).cursor;
  };
  await until(() => !!consume);
  try {
    for (const [i, id] of ['slow', 'fast'].entries())
      await consume!({
        id,
        direction: 'outbound',
        destinationId,
        status: 'queued',
        revision: i + 1,
      } as Message);
    await until(() => !!statuses.fast);
    expect(statuses.slow).toBeUndefined();
    expect(await cursor()).toBe(0);
    await until(() => !!statuses.slow);
  } finally {
    controller.abort();
    await run;
  }
  expect(statuses).toEqual({ slow: 'completed', fast: 'completed' });
  expect(await cursor()).toBe(2);
});
it('resolves the destination from the --target key when the config omits it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'herald-listener-'));
  folders.push(folder);
  const config = join(folder, 'runner.json'),
    destinationId = crypto.randomUUID();
  await writeFile(config, JSON.stringify({ command: process.execPath, cwd: folder }));
  let watching = false;
  const client = fake({
    async request(path: string) {
      if (path === '/destinations') return [{ id: destinationId, key: 'laptop' }];
      return {};
    },
    watch() {
      watching = true;
      return () => {};
    },
  });
  await expect(listen(client, config, 'desk', folder)).rejects.toThrow(
    'No destination has the key desk',
  );
  const controller = new AbortController();
  const run = listen(client, config, 'laptop', folder, controller.signal);
  for (let i = 0; i < 100 && !watching; i++) await new Promise((r) => setTimeout(r, 10));
  expect(watching).toBe(true);
  controller.abort();
  await run;
});
