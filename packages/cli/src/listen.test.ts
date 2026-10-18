import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeraldError } from '@herald-run/sdk';
import type { Message } from '@herald-run/sdk/schema';
import { keyedClient } from '../../sdk/fixtures/client';
import { opened, sealedTask } from '../../sdk/fixtures/sealed';
import { listen } from './listen';
const folders: string[] = [];
// A real keyed client whose HTTP and watch are stubbed, so its task methods seal and open.
const fake = async (stubs: object) => Object.assign(await keyedClient(), stubs);
/** A claim of the task at `path`, sealed by the owner. */
const claimed = async (path: string, destinationId: string, record: Partial<Message> = {}) => ({
  lease: 'lease',
  task: await sealedTask(
    { values: record.response?.values, session: record.session, attachments: record.attachments },
    { ...record, id: path.split('/')[2], destinationId },
  ),
});
/** Task IDs by readable name. */
const ids = (...names: string[]) =>
  Object.fromEntries(names.map((n) => [n, crypto.randomUUID()])) as Record<string, string>;
const named = (by: Record<string, string>, values: Record<string, string>) =>
  Object.fromEntries(Object.entries(by).map(([n, id]) => [n, values[id]]));
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
  let message = {} as Message;
  const client = await fake({
    async request(path: string, body: unknown) {
      requests.push({ path, body });
      if (path === '/destinations') return [{ id: destinationId }];
      if (path === `/tasks/${claimedElsewhere}/claim`)
        throw new HeraldError('Already claimed', 409);
      if (path.endsWith('/claim')) return claimed(path, destinationId, message);
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
  const key = 'k'.repeat(43);
  message = {
    title: 'Task',
    body: '',
    fields: [],
    attachments: [{ id: crypto.randomUUID(), name: 'brief.txt', type: 'text/plain', size: 4, key }],
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
  } as unknown as Message;
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
  const task = ids('limited', 'broken', 'broken-again');
  const statuses: Record<string, string> = {};
  const order: string[] = [];
  let consume: ((message: Message) => Promise<void>) | undefined;
  const client = await fake({
    async request(
      path: string,
      body: Record<string, unknown>,
      options?: { idempotencyKey?: string },
    ) {
      if (path === '/destinations') return [{ id: destinationId }];
      if (path.endsWith('/claim')) return claimed(path, destinationId);
      const id = path.split('/')[2];
      if (body.logs) {
        const sequence = (body.logs as Array<{ sequence: number }>)[0].sequence;
        logPosts.push({ id, key: options?.idempotencyKey, sequence });
        // 'limited' is rate limited once; 'broken*' never get their logs through.
        if (id === task.limited && logPosts.filter((p) => p.id === id).length === 1)
          throw new HeraldError('Rate limited.', 429, undefined, 0);
        if (id !== task.limited) throw new HeraldError('Unavailable.', 503, undefined, 0);
        order.push('logs');
        return {};
      }
      statuses[id] = body.status as string;
      if (id === task.limited) order.push(body.status as string);
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
  const queued = (id: string) =>
    ({ id, direction: 'outbound', destinationId, status: 'queued', revision: 1 }) as Message;
  try {
    await consume!(queued(task.limited));
    await consume!(queued(task.broken));
    await consume!(queued(task['broken-again']));
  } finally {
    controller.abort();
    await run;
  }
  expect(named(task, statuses)).toEqual({
    limited: 'completed',
    broken: 'completed',
    'broken-again': 'completed',
  });
  const limited = logPosts.filter((p) => p.id === task.limited);
  expect(limited).toHaveLength(2);
  expect(limited[0].key).toBe(`${task.limited}:logs:0`);
  expect(limited[1].key).toBe(limited[0].key);
  // A task's last logs flush before its completion update, not on the next interval.
  expect(order.indexOf('logs')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('logs')).toBeLessThan(order.indexOf('completed'));
  expect(logPosts.filter((p) => p.id === task.broken)).toHaveLength(5);
  // Once delivery has failed, later batches try once instead of stalling the queue.
  expect(logPosts.filter((p) => p.id === task['broken-again'])).toHaveLength(1);
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
  const reports: Array<Record<string, unknown>> = [];
  let consume: ((message: Message) => Promise<void>) | undefined;
  const client = await fake({
    async request(path: string, body: Record<string, unknown>) {
      paths.push(path);
      if (path === '/destinations') return [{ id: destinationId }];
      if (path.endsWith('/claim'))
        return { ...(await claimed(path, destinationId)), leaseExpiresAt };
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
    const id = crypto.randomUUID();
    await consume!({ id, direction: 'outbound', destinationId, status: 'queued' } as Message);
  } finally {
    controller.abort();
    await run;
  }
  expect(paths.find((p) => p.endsWith('/claim'))).toBeDefined();
  if (leaseExpiresAt) {
    expect(reports).toEqual([{ lease: 'lease', status: 'failed', errorSealed: expect.anything() }]);
    expect(await opened(reports[0].errorSealed as never)).toMatchObject({
      error: 'Task lease was lost.',
    });
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
  const task = ids('a', 'b', 'c');
  let consume: ((message: Message) => Promise<void>) | undefined;
  const client = await fake({
    async request(path: string, body: Record<string, unknown>) {
      if (path === '/destinations') return [{ id: destinationId }];
      if (path.endsWith('/claim')) return claimed(path, destinationId);
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
    for (const [i, id] of Object.values(task).entries())
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
  expect(named(task, statuses)).toEqual({ a: 'completed', b: 'completed', c: 'completed' });
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
  const task = ids('slow', 'fast');
  const script = `setTimeout(()=>{},process.env.HERALD_TASK_ID==='${task.slow}'?800:0)`;
  await writeFile(
    config,
    JSON.stringify({ destinationId, command: process.execPath, args: ['-e', script], cwd: folder }),
  );
  const statuses: Record<string, string> = {};
  let consume: ((message: Message) => Promise<void>) | undefined;
  const client = await fake({
    async request(path: string, body: Record<string, unknown>) {
      if (path === '/destinations') return [{ id: destinationId }];
      if (path.endsWith('/claim')) return claimed(path, destinationId);
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
    for (const [i, id] of Object.values(task).entries())
      await consume!({
        id,
        direction: 'outbound',
        destinationId,
        status: 'queued',
        revision: i + 1,
      } as Message);
    await until(() => !!statuses[task.fast]);
    expect(statuses[task.slow]).toBeUndefined();
    expect(await cursor()).toBe(0);
    await until(() => !!statuses[task.slow]);
  } finally {
    controller.abort();
    await run;
  }
  expect(named(task, statuses)).toEqual({ slow: 'completed', fast: 'completed' });
  expect(await cursor()).toBe(2);
});
it('resolves the destination from the --target key when the config omits it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'herald-listener-'));
  folders.push(folder);
  const config = join(folder, 'runner.json'),
    destinationId = crypto.randomUUID();
  await writeFile(config, JSON.stringify({ command: process.execPath, cwd: folder }));
  let watching = false;
  const client = await fake({
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
