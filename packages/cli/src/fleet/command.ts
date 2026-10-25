import { hostname } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { HeraldError, type Herald } from '@herald-run/sdk';
import {
  flattenAreas,
  unitActivities,
  unitKeySchema,
  worldPath,
  type UnitActivity,
  type UnitState,
} from '@herald-run/sdk/schema';
import { UsageError } from '../compose';
import { FleetDaemon, serveDaemon } from './daemon';
import { checkout, onOrigin, shortHash } from './git';
import { flushOverHttp, hookUpdate, reportOverHttp, squadOf, type HookInput } from './hook';
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
  squad?: string;
  parent?: string;
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
  /** Runs `herald <args>` (with this run's global options) in a detached process. */
  defer?: (args: string[]) => void;
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
      c.print(`Wrote ${worldPath} with ${flattenAreas(world).length} areas.`, world);
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
      const update = await hookUpdate(input, c.env);
      if (!update) return 0;
      if (await toDaemon(socketPath(c.env, c.directory, c.profile), update)) return 0;
      const defer = c.defer && (() => c.defer!(['fleet', 'flush', '--key', update.key]));
      const path = hookStatePath(c.env, c.profile);
      await reportOverHttp(c.client.fleet, update, path, Date.now(), undefined, defer);
      return 0;
    }
    case 'flush':
      if (values.key)
        await flushOverHttp(c.client.fleet, values.key, hookStatePath(c.env, c.profile));
      return 0;
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
    ...squadOf({ HERALD_FLEET_SQUAD: values.squad, HERALD_FLEET_PARENT: values.parent }),
    files,
  };
  const key = values.key || 'cli-' + shortHash(hostname(), root, name);
  if (values.parent !== undefined && !unitKeySchema.safeParse(values.parent).success)
    throw new UsageError('--parent is a unit key: 1-64 letters, digits, _ or -.');
  const world = await c.client.fleet.world(full);
  if (!world) throw new Error(`No Fleet world for ${full}. Add the repo in Herald first.`);
  const result = await c.client.fleet.report(world.id, [{ key, ttl, state: state as UnitState }]);
  if (ref && repo && ref !== world.repo.defaultBranch && (await onOrigin(repo.root, ref)))
    await c.client.fleet.track(world.id, ref).catch(() => {});
  c.print(`Reported ${key} to ${full}.`, { world: world.id, ...result });
  return 0;
}
