import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { version } from '@herald-run/sdk';

export type Run = (command: string, args: string[]) => Promise<{ code: number; stdout: string }>;
export type IntegrateIo = {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
  /** Runs a program without a shell; code 127 when it is not installed. */
  run: Run;
};
export type IntegrateOptions = {
  scope?: string;
  dryRun?: boolean;
  /** Passed to the MCP server as HERALD_PROFILE / HERALD_URL. */
  profile?: string;
  url?: string;
};
export const targets = ['claude-code', 'codex'] as const;
const marker = '<!-- Installed by herald integrate; rerun it to update. -->';
const mcpPackage = '@herald-run/mcp';
const planned: Record<string, string> = {
  installed: 'install',
  updated: 'update',
  registered: 'register',
};
/** Skills ship next to the bundle (`skills/`) or one level up in the source tree. */
function skillsDirectory() {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, 'skills'), join(here, '..', 'skills')].find((dir) => existsSync(dir))!;
}

const envKeys = ['HERALD_PROFILE', 'HERALD_URL'];
/** HERALD_* variables of a registered server: `codex mcp get --json` or `claude mcp get` text. */
function registeredEnv(stdout: string): Record<string, string> {
  let env: Record<string, string> = {};
  try {
    env = JSON.parse(stdout).transport?.env || {};
  } catch {
    for (const [, key, value] of stdout.matchAll(/^\s+([A-Z][A-Z0-9_]*)=(.*)$/gm)) env[key] = value;
  }
  return Object.fromEntries(envKeys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}
const sameEnv = (a: Record<string, string>, b: Record<string, string>) =>
  envKeys.every((k) => a[k] === b[k]);

/** Installs the skills and registers the MCP server; prints each change. Returns an exit code. */
export async function integrate(target: string, options: IntegrateOptions, io: IntegrateIo) {
  const scope = options.scope || 'user';
  if (!(targets as readonly string[]).includes(target) || !['user', 'project'].includes(scope))
    throw new Error('Usage: herald integrate claude-code|codex [--scope user|project]');
  const dry = !!options.dryRun;
  const report = (what: string, path: string) =>
    io.out(`${dry && what !== 'unchanged' ? 'would ' + planned[what] : what}  ${path}`);
  const codexHome = io.env.CODEX_HOME || join(io.home, '.codex');
  const skills =
    target === 'claude-code'
      ? join(scope === 'user' ? io.home : io.cwd, '.claude', 'skills')
      : scope === 'user'
        ? join(codexHome, 'skills')
        : join(io.cwd, '.agents', 'skills');
  let failed = false;
  const source = skillsDirectory();
  for (const name of (await readdir(source)).sort()) {
    const content = (await readFile(join(source, name, 'SKILL.md'), 'utf8')).trimEnd();
    const text = `${content}\n\n${marker}\n`;
    const path = join(skills, name, 'SKILL.md');
    const current = await readFile(path, 'utf8').catch(() => undefined);
    if (current === text) {
      report('unchanged', path);
      continue;
    }
    if (current !== undefined && !current.includes(marker)) {
      io.err(`Skipped ${path}: it was not installed by herald integrate.`);
      continue;
    }
    if (!dry) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    report(current === undefined ? 'installed' : 'updated', path);
  }

  const spec = `${mcpPackage}@${version}`;
  const env: Record<string, string> = {};
  if (options.profile && options.profile !== 'default') env.HERALD_PROFILE = options.profile;
  if (options.url) env.HERALD_URL = options.url;
  const server = {
    command: 'npx',
    args: ['-y', spec],
    ...(Object.keys(env).length ? { env } : {}),
  };
  if (scope === 'project' && target === 'claude-code') {
    const path = join(io.cwd, '.mcp.json');
    const config = JSON.parse((await readFile(path, 'utf8').catch(() => '')) || '{}');
    const existing = config.mcpServers?.herald;
    if (JSON.stringify(existing) === JSON.stringify(server)) report('unchanged', path);
    else if (existing && !JSON.stringify(existing).includes(mcpPackage))
      io.err(`Kept the existing "herald" server in ${path}.`);
    else {
      config.mcpServers = { ...config.mcpServers, herald: server };
      if (!dry) await writeFile(path, JSON.stringify(config, null, 2) + '\n');
      report(existing ? 'updated' : 'registered', path + ' (mcpServers.herald)');
    }
  } else if (scope === 'project') {
    const path = join(io.cwd, '.codex', 'config.toml');
    const text = await readFile(path, 'utf8').catch(() => '');
    const block = [
      '[mcp_servers.herald]',
      'command = "npx"',
      `args = ["-y", "${spec}"]`,
      ...(Object.keys(env).length
        ? [
            `env = { ${Object.entries(env)
              .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
              .join(', ')} }`,
          ]
        : []),
    ].join('\n');
    // The table runs from its header to the next header.
    const found = /^\[mcp_servers\.herald\]\n(?:(?!\[).*(?:\n|$))*/m.exec(text);
    if (found?.[0].trimEnd() === block) report('unchanged', path);
    else if (found && !found[0].includes(mcpPackage))
      io.err(`Kept the existing [mcp_servers.herald] in ${path}.`);
    else {
      const next = found
        ? text.replace(found[0], block + (/\n*$/.exec(found[0])![0] || '\n'))
        : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}\n`;
      if (!dry) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, next);
      }
      report(found ? 'updated' : 'registered', path + ' [mcp_servers.herald]');
    }
  } else {
    const cli = target === 'claude-code' ? 'claude' : 'codex';
    const envFlags = Object.entries(env).flatMap(([k, v]) => [
      cli === 'claude' ? '-e' : '--env',
      `${k}=${v}`,
    ]);
    // The name goes first: `claude mcp add -e` takes several values and would swallow it.
    const add =
      cli === 'claude'
        ? ['mcp', 'add', '--scope', 'user', 'herald', ...envFlags, '--', 'npx', '-y', spec]
        : ['mcp', 'add', 'herald', ...envFlags, '--', 'npx', '-y', spec];
    const where = `${cli} MCP server herald (${spec})`;
    const current = await io.run(cli, [
      'mcp',
      'get',
      'herald',
      ...(cli === 'codex' ? ['--json'] : []),
    ]);
    if (current.code === 127) {
      io.err(`${cli} is not installed. Install it, then run: ${cli} ${add.join(' ')}`);
      failed = true;
    } else if (
      current.code === 0 &&
      current.stdout.includes(spec) &&
      sameEnv(registeredEnv(current.stdout), env)
    )
      report('unchanged', where);
    else if (current.code === 0 && !current.stdout.includes(mcpPackage))
      io.err(`Kept the existing ${cli} MCP server named herald.`);
    else {
      if (!dry) {
        if (current.code === 0)
          await io.run(cli, [
            'mcp',
            'remove',
            ...(cli === 'claude' ? ['--scope', 'user'] : []),
            'herald',
          ]);
        const added = await io.run(cli, add);
        if (added.code !== 0) {
          io.err(`${cli} ${add.join(' ')} failed.`);
          failed = true;
        }
      }
      if (!failed) report(current.code === 0 ? 'updated' : 'registered', where);
    }
  }
  if (!dry && !failed)
    io.err(
      `Done. Restart ${target === 'claude-code' ? 'Claude Code' : 'Codex'}; the MCP server uses your herald login or HERALD_API_KEY.`,
    );
  return failed ? 1 : 0;
}
