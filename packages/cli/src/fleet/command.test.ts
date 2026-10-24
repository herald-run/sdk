import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { worldFileSchema } from '@herald-run/sdk/schema';
import * as sealed from '../../../sdk/fixtures/sealed';
import { main, type Io } from '../main';
let dir = '',
  root = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herald-fleet-'));
  root = join(dir, 'app');
  for (const d of ['src', 'docs', '.github']) await mkdir(join(root, d), { recursive: true });
  for (const f of ['src/a.ts', 'docs/a.md', '.github/ci.yml']) await writeFile(join(root, f), '');
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
  git('init', '-q', '-b', 'feature');
  git('remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git('add', '.');
  git('commit', '-qm', 'init');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
const world = {
  id: 'fw_1',
  repo: { id: 1, fullName: 'acme/app', url: '', defaultBranch: 'main', private: true },
  createdAt: '',
};
async function run(argv: string[]) {
  const out: string[] = [],
    err: string[] = [];
  const io: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    write: () => {},
    env: { HERALD_URL: 'https://herald.test', HERALD_TOKEN: sealed.token },
    home: dir,
    open: () => false,
    cwd: join(root, 'src'),
  };
  const code = await main(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}
type Seen = { route: string; body?: unknown };
function server(routes: Record<string, () => Response>) {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const route = `${init?.method || 'GET'} ${new URL(String(input)).pathname}`;
    seen.push({ route, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (route === 'GET /api/v1/keys') return Response.json(sealed.directory);
    return routes[route]?.() ?? Response.json({ error: 'Not found.' }, { status: 404 });
  });
  return seen;
}

it('init writes a derived world file at the git root and refuses to overwrite it', async () => {
  const first = await run(['fleet', 'init']);
  expect(first).toMatchObject({ code: 0, out: 'Wrote .herald/world.json with 2 areas.' });
  const path = join(root, '.herald/world.json');
  const text = await readFile(path, 'utf8');
  expect(text).toMatch(/^\{\n {2}"version": 1,/);
  expect(worldFileSchema.parse(JSON.parse(text)).areas.map((a) => [a.id, a.kind])).toEqual([
    ['docs', 'docs'],
    ['src', 'service'],
  ]);
  await writeFile(path, '{"custom": true}');
  expect(await run(['fleet', 'init'])).toMatchObject({
    code: 1,
    err: '.herald/world.json exists; pass --force to replace it.',
  });
  expect(await readFile(path, 'utf8')).toBe('{"custom": true}');
  expect((await run(['fleet', 'init', '--force', '--json'])).code).toBe(0);
  expect(await readFile(path, 'utf8')).toBe(text);
});

it('lists worlds and reports a unit with defaults from the checkout', async () => {
  const seen = server({
    'GET /api/v1/fleet': () => Response.json({ worlds: [world] }),
    'POST /api/v1/fleet/worlds/fw_1/units': () =>
      Response.json({ units: [{ key: 'k', expiresAt: 'x' }] }),
    'PUT /api/v1/fleet/worlds/fw_1/refs': () => Response.json({ ok: true }, { status: 202 }),
  });
  expect(await run(['fleet', 'worlds'])).toMatchObject({
    code: 0,
    out: 'fw_1  acme/app  private',
  });
  const reported = await run(['fleet', 'report', '--file', 'a.ts', '--activity', 'editing']);
  expect(reported).toMatchObject({
    code: 0,
    out: expect.stringMatching(/^Reported cli-\S+ to acme\/app\.$/),
  });
  const body = seen.find((s) => s.route.startsWith('POST'))!.body as {
    units: { key: string; sealed: Parameters<typeof sealed.opened>[0] }[];
  };
  expect(await sealed.opened(body.units[0].sealed)).toMatchObject({
    name: 'app',
    ref: 'feature',
    area: 'src',
    activity: 'editing',
    files: ['src/a.ts'],
  });
  // A non-default branch is tracked once pushed; the key is stable.
  expect(seen.filter((s) => s.route.startsWith('PUT'))).toEqual([]);
  execFileSync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/feature', 'HEAD']);
  await run(['fleet', 'report', '--json']);
  expect(seen.filter((s) => s.route.startsWith('PUT')).map((s) => s.body)).toEqual([
    { ref: 'feature' },
  ]);
  const keys = seen
    .filter((s) => s.route.startsWith('POST'))
    .map((s) => (s.body as typeof body).units[0].key);
  expect(new Set(keys).size).toBe(1);
});

it('reports usage errors and missing worlds or scopes', async () => {
  server({
    'GET /api/v1/fleet': () => Response.json({ worlds: [] }),
  });
  expect((await run(['fleet'])).code).toBe(2);
  expect((await run(['fleet', 'report', '--activity', 'dancing'])).code).toBe(2);
  expect((await run(['fleet', 'report', '--ttl', '5'])).code).toBe(2);
  expect(await run(['fleet', 'report'])).toMatchObject({
    code: 1,
    err: 'No Fleet world for acme/app. Add the repo in Herald first.',
  });
  vi.restoreAllMocks();
  server({
    'GET /api/v1/fleet': () =>
      Response.json({ error: 'fleet:write scope is required.' }, { status: 403 }),
  });
  expect(await run(['fleet', 'worlds'])).toMatchObject({
    code: 1,
    err: 'fleet:write scope is required. Run herald login again to grant it.',
  });
});

it('documents the fleet actions and their options', async () => {
  const { code, out } = await run(['help', 'fleet']);
  expect(code).toBe(0);
  for (const text of [
    'init|worlds|report|hook|daemon',
    '--file PATH        A file the unit',
    '--ttl SECONDS',
  ])
    expect(out).toContain(text);
});
