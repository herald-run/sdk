import { lstat, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { areaOf, type UnitActivity, type UnitState } from '@herald-run/sdk/schema';
import type { Fleet } from '@herald-run/sdk';
import { checkout, shortHash } from './git';
import { mergeState, type FleetUpdate } from './protocol';
import { localWorld } from './world';
/** The Claude Code hook fields Fleet reads. */
export type HookInput = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; path?: unknown; notebook_path?: unknown };
};
const reading = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const editing = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** A hook event's activity, `remove` for a session's end, or undefined to ignore it. */
export function activityOf(event?: string, tool?: string): UnitActivity | 'remove' | undefined {
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
      return tool && reading.has(tool)
        ? 'reading'
        : tool && editing.has(tool)
          ? 'editing'
          : 'running';
    case 'UserPromptSubmit':
      return 'running';
    case 'Stop':
    case 'SessionStart':
      return 'idle';
    case 'Notification':
      return 'waiting';
    case 'SessionEnd':
      return 'remove';
  }
  return undefined;
}
/** A repo-relative path inside `root`, else undefined. */
function inside(root: string, cwd: string, path: unknown) {
  if (typeof path !== 'string' || !path) return undefined;
  const rel = relative(root, resolve(cwd, path)).split('\\').join('/');
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : undefined;
}
/** The Fleet update a hook event stands for, or undefined when it has none. */
export async function hookUpdate(input: HookInput): Promise<FleetUpdate | undefined> {
  const activity = activityOf(input.hook_event_name, input.tool_name);
  if (!activity || !input.session_id || !input.cwd) return undefined;
  const repo = await checkout(input.cwd);
  if (!repo?.repo) return undefined;
  const key = 'cc-' + shortHash(input.session_id);
  if (activity === 'remove') return { repo: repo.repo, key, remove: true };
  const state: Partial<UnitState> = {
    name: `${basename(repo.root)}${repo.branch ? ` (${repo.branch})` : ''}`.slice(0, 80),
    kind: 'claude-code',
    activity,
    ...(repo.branch ? { ref: repo.branch } : {}),
  };
  const raw = input.tool_input ?? {};
  const file = inside(repo.root, input.cwd, raw.file_path ?? raw.notebook_path);
  const dir = file ? undefined : inside(repo.root, input.cwd, raw.path);
  if (file || dir) {
    const world = await localWorld(repo.root);
    const isDir =
      dir && (await stat(resolve(repo.root, dir)).catch(() => undefined))?.isDirectory();
    const path = file ?? (isDir ? dir + '/' : dir)!;
    state.area = areaOf(world, path);
    if (file || !isDir) state.files = [path];
  }
  return { repo: repo.repo, key, state };
}
/** HTTP fallback writes per unit at most this often. */
export const HTTP_EVERY = 15_000;
type HookState = {
  worlds: Record<string, { id: string | null; at: number }>;
  units: Record<string, { at: number; state: Partial<UnitState> }>;
};
async function readState(path: string): Promise<HookState> {
  try {
    const info = await lstat(path);
    // Only a regular file of this user's: the temp directory is shared.
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) throw new Error();
    const data = JSON.parse(await readFile(path, 'utf8')) as HookState;
    return { worlds: data.worlds ?? {}, units: data.units ?? {} };
  } catch {
    return { worlds: {}, units: {} };
  }
}
async function writeState(path: string, data: HookState, now: number) {
  for (const [key, unit] of Object.entries(data.units))
    if (now - unit.at > 86_400_000) delete data.units[key];
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
  await rename(temp, path);
}
/**
 * Reports an update over HTTP without a daemon: each unit at most every 15 s, merging what
 * arrives in between; world ids are cached in the 0600 state file.
 */
export async function reportOverHttp(
  fleet: Pick<Fleet, 'world' | 'report' | 'remove'>,
  update: FleetUpdate,
  statePath: string,
  now = Date.now(),
  signal?: AbortSignal,
) {
  const data = await readState(statePath);
  const unit = data.units[update.key];
  const state = mergeState(unit?.state, update.state);
  const due = update.remove || !unit || now - unit.at >= HTTP_EVERY;
  data.units[update.key] = { at: unit?.at ?? 0, state };
  if (!due) return writeState(statePath, data, now);
  let world = data.worlds[update.repo];
  if (!world || now - world.at > (world.id ? 3_600_000 : 600_000)) {
    world = { id: (await fleet.world(update.repo))?.id ?? null, at: now };
    data.worlds[update.repo] = world;
  }
  try {
    if (!world.id) return;
    if (update.remove) {
      delete data.units[update.key];
      await fleet.remove(world.id, update.key, { signal, retry: false }).catch(() => {});
      return;
    }
    if (!state.name) return;
    data.units[update.key]!.at = now;
    await fleet.report(
      world.id,
      [{ key: update.key, ttl: update.ttl, state: state as UnitState }],
      { signal, retry: false },
    );
  } finally {
    await writeState(statePath, data, now);
  }
}
