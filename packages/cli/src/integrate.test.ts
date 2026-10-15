import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { version } from '@herald-run/sdk';
import { main, type Io } from './main';
let home = '',
  cwd = '';
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'herald-integrate-'));
  cwd = join(home, 'project');
  await mkdir(cwd);
});
afterEach(() => rm(home, { recursive: true, force: true }));
const spec = `@herald-run/mcp@${version}`;
/** A fake `claude`/`codex` whose MCP registry is `servers`; `claude -e` takes several values. */
function programs(servers: Record<string, string> = {}, missing = false) {
  const calls: string[] = [];
  const env: Record<string, Record<string, string>> = {};
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args].join(' '));
    if (missing) return { code: 127, stdout: '' };
    if (args[1] === 'get') {
      if (!servers.herald) return { code: 1, stdout: '' };
      const vars = env.herald || {};
      const stdout =
        command === 'codex'
          ? JSON.stringify({ transport: { args: servers.herald.split(' ').slice(1), env: vars } })
          : `herald:\n  Args: ${servers.herald}\n  Environment:\n${Object.entries(vars)
              .map(([k, v]) => `    ${k}=${v}\n`)
              .join('')}`;
      return { code: 0, stdout };
    }
    if (args[1] === 'remove') delete servers.herald;
    if (args[1] === 'add') {
      const options = args.slice(2, args.indexOf('--'));
      const vars: Record<string, string> = {};
      let name: string | undefined;
      for (let i = 0; i < options.length; i++) {
        if (options[i] === '--scope') i++;
        else if (options[i] === '-e' || options[i] === '--env') {
          // claude's -e takes values up to the next option, as the real CLI does.
          const variadic = command === 'claude';
          do {
            const [key, value] = (options[++i] ?? '').split(/=(.*)/s);
            if (value === undefined) return { code: 1, stdout: '' };
            vars[key] = value;
          } while (variadic && options[i + 1] && !options[i + 1].startsWith('-'));
        } else name ??= options[i];
      }
      if (!name) return { code: 1, stdout: '' };
      servers[name] = args.slice(args.indexOf('--') + 1).join(' ');
      env[name] = vars;
    }
    return { code: 0, stdout: '' };
  };
  return { calls, run, servers, env };
}
async function integrate(argv: string[], run: Io['run']) {
  const out: string[] = [],
    err: string[] = [];
  const io: Io = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    write: () => {},
    env: {},
    home,
    cwd,
    run,
    open: () => false,
  };
  const code = await main(['integrate', ...argv], io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

it('installs Claude Code skills and registers the MCP server idempotently', async () => {
  const fake = programs();
  const dry = await integrate(['claude-code', '--dry-run'], fake.run);
  expect(dry.out).toContain('would install  ');
  expect(fake.calls).toEqual(['claude mcp get herald']);
  await expect(readdir(join(home, '.claude'))).rejects.toThrow();

  const first = await integrate(['claude-code'], fake.run);
  expect(first.code).toBe(0);
  const skills = await readdir(join(home, '.claude', 'skills'));
  expect(skills).toEqual([
    'herald-ask',
    'herald-get-secret',
    'herald-send-file',
    'herald-share-secret',
  ]);
  expect(fake.calls.at(-1)).toBe(`claude mcp add --scope user herald -- npx -y ${spec}`);
  expect(fake.servers.herald).toBe(`npx -y ${spec}`);

  fake.calls.length = 0;
  const again = await integrate(['claude-code'], fake.run);
  expect(again.out.split('\n').every((line) => line.startsWith('unchanged'))).toBe(true);
  expect(fake.calls).toEqual(['claude mcp get herald']);
});

it('passes the profile to Claude Code and re-registers when it changes', async () => {
  const fake = programs();
  const work = await integrate(['claude-code', '--profile', 'work'], fake.run);
  expect(work.code).toBe(0);
  expect(fake.calls.at(-1)).toBe(
    `claude mcp add --scope user herald -e HERALD_PROFILE=work -- npx -y ${spec}`,
  );
  expect(fake.env.herald).toEqual({ HERALD_PROFILE: 'work' });
  fake.calls.length = 0;
  expect((await integrate(['claude-code', '--profile', 'work'], fake.run)).out).not.toMatch(
    /updated|registered/,
  );
  expect(fake.calls).toEqual(['claude mcp get herald']);
  const home = await integrate(['claude-code', '--profile', 'home'], fake.run);
  expect(home.out).toContain('updated  claude MCP server herald');
  expect(fake.env.herald).toEqual({ HERALD_PROFILE: 'home' });
  await integrate(['claude-code'], fake.run);
  expect(fake.env.herald).toEqual({});

  const codex = programs();
  await integrate(['codex', '--profile', 'work'], codex.run);
  await integrate(['codex', '--profile', 'home'], codex.run);
  expect(codex.env.herald).toEqual({ HERALD_PROFILE: 'home' });
});

it('upgrades its own entries and never overwrites foreign ones', async () => {
  const fake = programs({ herald: 'npx -y @herald-run/mcp@0.0.1' });
  const own = join(home, '.codex', 'skills', 'herald-ask');
  const foreign = join(home, '.codex', 'skills', 'herald-send-file');
  await mkdir(own, { recursive: true });
  await mkdir(foreign, { recursive: true });
  await writeFile(
    join(own, 'SKILL.md'),
    'old\n<!-- Installed by herald integrate; rerun it to update. -->\n',
  );
  await writeFile(join(foreign, 'SKILL.md'), 'mine');
  const result = await integrate(['codex', '--profile', 'work'], fake.run);
  expect(result.out).toContain('updated  ' + join(own, 'SKILL.md'));
  expect(result.err).toContain('Skipped ' + join(foreign, 'SKILL.md'));
  expect(await readFile(join(foreign, 'SKILL.md'), 'utf8')).toBe('mine');
  expect(fake.calls).toContain('codex mcp remove herald');
  expect(fake.calls.at(-1)).toBe(
    `codex mcp add herald --env HERALD_PROFILE=work -- npx -y ${spec}`,
  );

  const other = programs({ herald: 'node my-own-server.js' });
  expect((await integrate(['codex'], other.run)).err).toContain('Kept the existing codex MCP');
  expect(other.calls).toEqual(['codex mcp get herald --json']);
});

it('writes project config files for both targets', async () => {
  const none = programs();
  await writeFile(join(cwd, '.mcp.json'), '{"mcpServers":{"other":{"command":"x"}}}');
  await integrate(['claude-code', '--scope', 'project'], none.run);
  const mcp = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'));
  expect(mcp.mcpServers).toEqual({
    other: { command: 'x' },
    herald: { command: 'npx', args: ['-y', spec] },
  });
  expect(await readdir(join(cwd, '.claude', 'skills'))).toHaveLength(4);

  await mkdir(join(cwd, '.codex'));
  await writeFile(
    join(cwd, '.codex', 'config.toml'),
    'model = "x"\n\n[mcp_servers.herald]\ncommand = "npx"\nargs = ["-y", "@herald-run/mcp@0.0.1"]\n\n[other]\na = 1\n',
  );
  const codex = await integrate(['codex', '--scope', 'project'], none.run);
  expect(codex.out).toContain('updated');
  expect(await readFile(join(cwd, '.codex', 'config.toml'), 'utf8')).toBe(
    `model = "x"\n\n[mcp_servers.herald]\ncommand = "npx"\nargs = ["-y", "${spec}"]\n\n[other]\na = 1\n`,
  );
  expect(await readdir(join(cwd, '.agents', 'skills'))).toHaveLength(4);
  expect((await integrate(['codex', '--scope', 'project'], none.run)).out).not.toMatch(
    /updated|registered/,
  );
  expect(none.calls).toEqual([]);
});

it('explains a missing program and rejects unknown targets', async () => {
  const missing = await integrate(['claude-code'], programs({}, true).run);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain(`claude mcp add --scope user herald -- npx -y ${spec}`);
  expect((await integrate(['cursor'], programs().run)).code).toBe(1);
  expect((await integrate(['codex', '--scope', 'team'], programs().run)).code).toBe(1);
});
