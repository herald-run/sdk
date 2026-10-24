import { hostname } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { HeraldError, type Herald } from '@herald-run/sdk';
import {
  unitActivities,
  worldPath,
  type UnitActivity,
  type UnitState,
} from '@herald-run/sdk/schema';
import { UsageError } from '../compose';
import { FleetDaemon, serveDaemon } from './daemon';
import { checkout, shortHash } from './git';
import { hookUpdate, reportOverHttp, type HookInput } from './hook';
import { hookStatePath, socketPath, toDaemon } from './protocol';
import { areaFor, initWorld, localWorld } from './world';
export type FleetValues = {
  force?: boolean;
  area?: string;
  activity?: string;
  task?: string;
  file?: string[];
  ref?: string;
  name?: string;
  kind?: string;
  key?: string;
  ttl?: string;
  repo?: string;
};
export type FleetContext = {
  values: FleetValues;
  client: Herald;
  /** Herald's config directory and profile, for the daemon socket and hook state. */
  directory: string;
  profile: string;
  env: Record<string, string | undefined>;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  print: (human: string, json: unknown) => void;
  stdin?: () => Promise<string>;
  signal?: AbortSignal;
};
const scopeHint = (error: unknown) => {
  if (error instanceof HeraldError && error.status === 403 && /fleet:write/.test(error.message))
    error.message += ' Run herald login again to grant it.';
  return error;
};
/** `herald fleet <action>`; returns the exit code. */
export async function fleet(action: string | undefined, c: FleetContext): Promise<number> {
  try {
    return await run(action, c);
  } catch (error) {
    throw scopeHint(error);
  }
}
async function run(action: string | undefined, c: FleetContext): Promise<number> {
  const { values } = c;
  switch (action) {
    case 'init': {
      const repo = await checkout(c.cwd);
      if (!repo) throw new UsageError('Run herald fleet init inside a git checkout.');
      const world = await initWorld(repo.root, values.force);
      if (!world) {
        c.err(`${worldPath} exists; pass --force to replace it.`);
        return 1;
      }
      c.print(`Wrote ${worldPath} with ${world.areas.length} areas.`, world);
      return 0;
    }
    case 'worlds': {
      const worlds = await c.client.fleet.worlds();
      c.print(
        worlds
          .map((w) => `${w.id}  ${w.repo.fullName}${w.repo.private ? '  private' : ''}`)
          .join('\n') || 'No Fleet worlds. Add a repo in Herald.',
        worlds,
      );
      return 0;
    }
    case 'report':
      return report(c);
    case 'hook': {
      const input = JSON.parse((await c.stdin?.()) || '{}') as HookInput;
      const update = await hookUpdate(input);
      if (!update) return 0;
      if (await toDaemon(socketPath(c.env, c.directory, c.profile), update)) return 0;
      await reportOverHttp(c.client.fleet, update, hookStatePath(c.env, c.profile));
      return 0;
    }
    case 'daemon': {
      const daemon = new FleetDaemon(c.client.fleet, { log: c.err });
      await serveDaemon(daemon, socketPath(c.env, c.directory, c.profile), c.err, c.signal);
      return 0;
    }
  }
  throw new UsageError('Usage: herald fleet init|worlds|report|hook|daemon');
}
async function report(c: FleetContext) {
  const { values } = c;
  const repo = await checkout(c.cwd);
  const full = values.repo || repo?.repo;
  if (!full) throw new UsageError('Pass --repo owner/repo: no GitHub origin remote found.');
  const activity = values.activity as UnitActivity | undefined;
  if (activity && !unitActivities.includes(activity))
    throw new UsageError(`--activity is one of ${unitActivities.join(', ')}.`);
  let ttl: number | undefined;
  if (values.ttl !== undefined) {
    ttl = Number(values.ttl);
    if (!/^\d+$/.test(values.ttl) || ttl < 30 || ttl > 3600)
      throw new UsageError('--ttl is 30 to 3600 seconds.');
  }
  const root = repo?.root ?? c.cwd;
  const files = (values.file ?? []).map((f) => {
    const rel = relative(root, resolve(c.cwd, f)).split('\\').join('/');
    return rel.startsWith('..') || isAbsolute(rel) ? f : rel;
  });
  const ref = values.ref ?? repo?.branch;
  const name = values.name || basename(root) || hostname();
  const area =
    values.area ?? (repo && files.length ? areaFor(await localWorld(root), files) : undefined);
  const state: Partial<UnitState> = {
    name,
    ...(values.kind ? { kind: values.kind } : {}),
    ...(ref ? { ref } : {}),
    ...(area ? { area } : {}),
    ...(activity ? { activity } : {}),
    ...(values.task ? { task: values.task } : {}),
    files,
  };
  const key = values.key || 'cli-' + shortHash(hostname(), root, name);
  const world = await c.client.fleet.world(full);
  if (!world) throw new Error(`No Fleet world for ${full}. Add the repo in Herald first.`);
  const result = await c.client.fleet.report(world.id, [{ key, ttl, state: state as UnitState }]);
  if (ref && ref !== world.repo.defaultBranch)
    await c.client.fleet.track(world.id, ref).catch(() => {});
  c.print(`Reported ${key} to ${full}.`, { world: world.id, ...result });
  return 0;
}
