import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HeraldError } from '@herald-run/sdk';
import { main, type Io } from '../main';
import { parseRemote, shortHash } from './git';
import { activityOf, hookUpdate, reportOverHttp } from './hook';
/** SSH remote user, split so the source holds no address-like text. */
const GIT = 'git' + '@';
let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herald-fleet-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
/** A committed checkout on `main` with a GitHub origin and src/, docs/. */
async function repo() {
  const root = join(dir, 'app');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'src/a.ts'), '');
  await writeFile(join(root, 'docs/a.md'), '');
  const git = (...args: string[]) =>
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      ...args,
    ]);
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', GIT + 'github.com:acme/app.git');
  git('add', '.');
  git('commit', '-qm', 'init');
  return root;
}

it('parses GitHub remotes in HTTPS and SSH forms', () => {
  for (const url of [
    'https://github.com/acme/app.git',
    'https://user' + '@github.com/acme/app',
    GIT + 'github.com:acme/app.git',
    'ssh://' + GIT + 'github.com/acme/app.git',
    'ssh://' + GIT + 'github.com:22/acme/app',
    'git://github.com/acme/app.git/',
  ])
    expect(parseRemote(url), url).toBe('acme/app');
  expect(parseRemote('https://github.com/acme/my.repo.git')).toBe('acme/my.repo');
  for (const url of ['https://gitlab.com/acme/app.git', 'https://github.com/acme', 'not a url'])
    expect(parseRemote(url), url).toBeUndefined();
});

it('maps hook events and tools to activities', () => {
  const cases: [string, string | undefined, string | undefined][] = [
    ['PreToolUse', 'Read', 'reading'],
    ['PostToolUse', 'Grep', 'reading'],
    ['PreToolUse', 'Glob', 'reading'],
    ['PreToolUse', 'LS', 'reading'],
    ['PreToolUse', 'Edit', 'editing'],
    ['PreToolUse', 'Write', 'editing'],
    ['PreToolUse', 'MultiEdit', 'editing'],
    ['PreToolUse', 'NotebookEdit', 'editing'],
    ['PreToolUse', 'Bash', 'running'],
    ['PreToolUse', 'WebFetch', 'running'],
    ['UserPromptSubmit', undefined, 'running'],
    ['Stop', undefined, 'idle'],
    ['Notification', undefined, 'waiting'],
    ['SessionEnd', undefined, 'remove'],
    ['PreCompact', undefined, undefined],
  ];
  for (const [event, tool, activity] of cases)
    expect(activityOf(event, tool), `${event} ${tool}`).toBe(activity);
});

it('builds updates from hook input: key, name, branch, area and files', async () => {
  const root = await repo();
  const base = { session_id: 's1', cwd: root };
  const key = 'cc-' + shortHash('s1');
  expect(
    await hookUpdate({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(root, 'src/a.ts') },
    }),
  ).toEqual({
    repo: 'acme/app',
    key,
    state: {
      name: 'app (main)',
      kind: 'claude-code',
      activity: 'editing',
      ref: 'main',
      area: 'src',
      files: ['src/a.ts'],
    },
  });
  // A directory sets the area only; paths outside the checkout are ignored.
  const grep = await hookUpdate({
    ...base,
    hook_event_name: 'PreToolUse',
    tool_name: 'Grep',
    tool_input: { path: 'docs' },
  });
  expect(grep?.state).toMatchObject({ activity: 'reading', area: 'docs' });
  expect(grep?.state?.files).toBeUndefined();
  const outside = await hookUpdate({
    ...base,
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/etc/hosts' },
  });
  expect(outside?.state?.area).toBeUndefined();
  expect(await hookUpdate({ ...base, hook_event_name: 'SessionEnd' })).toEqual({
    repo: 'acme/app',
    key,
    remove: true,
  });
  expect(await hookUpdate({ ...base, hook_event_name: 'PreCompact' })).toBeUndefined();
  expect(await hookUpdate({ ...base, cwd: dir, hook_event_name: 'Stop' })).toBeUndefined();
});

it('reports over HTTP at most every 15 s per unit, merging what arrives between', async () => {
  const path = join(dir, 'state.json');
  const world = vi.fn(async () => ({ id: 'fw_1' }) as never);
  const report = vi.fn(async () => ({ units: [] }));
  const remove = vi.fn(async () => {});
  const fleet = { world, report, remove };
  const update = (state: object) => ({ repo: 'acme/app', key: 'cc-1', state });
  await reportOverHttp(fleet, update({ name: 'app', activity: 'reading', files: ['a'] }), path, 0);
  await reportOverHttp(fleet, update({ activity: 'editing', files: ['b'] }), path, 5000);
  expect(report).toHaveBeenCalledTimes(1);
  await reportOverHttp(fleet, update({ activity: 'idle' }), path, 15_000);
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.lastCall).toEqual([
    'fw_1',
    [{ key: 'cc-1', state: { name: 'app', activity: 'idle', files: ['b', 'a'] } }],
    { retry: false, signal: undefined },
  ]);
  // The world id is cached; the state file is private.
  expect(world).toHaveBeenCalledTimes(1);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  // A failed write still counts against the interval.
  report.mockRejectedValueOnce(new HeraldError('Slow down.', 429));
  await expect(reportOverHttp(fleet, update({}), path, 30_000)).rejects.toThrow('Slow down.');
  await reportOverHttp(fleet, update({}), path, 31_000);
  expect(report).toHaveBeenCalledTimes(3);
  await reportOverHttp(fleet, { repo: 'acme/app', key: 'cc-1', remove: true }, path, 31_000);
  expect(remove).toHaveBeenCalledWith('fw_1', 'cc-1', { retry: false, signal: undefined });
  expect(JSON.parse(await readFile(path, 'utf8')).units).toEqual({});
});

const io = (stdin: () => Promise<string>, env: Record<string, string> = {}) => {
  const lines: string[] = [];
  const value: Io = {
    out: (l) => lines.push('out:' + l),
    err: (l) => lines.push('err:' + l),
    write: (c) => lines.push('write:' + String(c)),
    env: { HERALD_URL: 'https://herald.test', XDG_RUNTIME_DIR: dir, ...env },
    home: dir,
    open: () => false,
    stdin,
  };
  return { value, lines };
};

it('the hook always exits 0 quickly and prints nothing', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  for (const stdin of ['not json', '{}', JSON.stringify({ hook_event_name: 'Stop', cwd: '/' })]) {
    const { value, lines } = io(async () => stdin);
    expect(await main(['fleet', 'hook', '--bogus'], value)).toBe(0);
    expect(lines).toEqual([]);
  }
  // Stdin that never ends still returns within the timeout.
  const { value, lines } = io(() => new Promise(() => {}));
  const started = Date.now();
  expect(await main(['fleet', 'hook'], value)).toBe(0);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(lines).toEqual([]);
});

it('the hook hands updates to a running daemon', async () => {
  const root = await repo();
  const received: string[] = [];
  const server = createServer((s) => s.on('data', (d) => received.push(String(d))));
  await new Promise<void>((resolve) => server.listen(join(dir, 'herald-fleet.sock'), resolve));
  const fetch = vi.spyOn(globalThis, 'fetch');
  const input = { session_id: 's1', cwd: root, hook_event_name: 'Stop' };
  const { value, lines } = io(async () => JSON.stringify(input));
  expect(await main(['fleet', 'hook'], value)).toBe(0);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(JSON.parse(received.join(''))).toMatchObject({
    repo: 'acme/app',
    state: { activity: 'idle', name: 'app (main)' },
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(lines).toEqual([]);
});
