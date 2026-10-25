import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  areaOf,
  deriveWorld,
  worldFileBytes,
  worldFileSchema,
  worldPath,
  type WorldFile,
} from '@herald-run/sdk/schema';
import { git } from './git';
const skip = (name: string) => name.startsWith('.') || name === 'node_modules';
/** Directories two levels deep (`apps`, `apps/site`) git tracks at HEAD, else those on disk. */
export async function directories(root: string): Promise<string[]> {
  const top = await git(root, ['ls-tree', '-d', '--name-only', 'HEAD']);
  if (top !== undefined) {
    const dirs = top.split('\n').filter((d) => d && !skip(d));
    const subs = dirs.length
      ? await git(root, ['ls-tree', '-d', '--name-only', 'HEAD', '--', ...dirs.map((d) => `${d}/`)])
      : '';
    return [...dirs, ...(subs ?? '').split('\n').filter(Boolean)];
  }
  const list = async (dir: string) =>
    (await readdir(join(root, dir), { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && !skip(e.name))
      .map((e) => (dir ? `${dir}/${e.name}` : e.name));
  const dirs = await list('');
  return [...dirs, ...(await Promise.all(dirs.map(list))).flat()];
}
/** The checkout's world file, or one derived from its directories. */
export async function localWorld(root: string): Promise<WorldFile> {
  const text = await readFile(join(root, worldPath), 'utf8').catch(() => undefined);
  if (text !== undefined && text.length <= worldFileBytes) {
    try {
      const parsed = worldFileSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      /* Invalid JSON: derive instead. */
    }
  }
  return deriveWorld(await directories(root), basename(root));
}
/** The area of the first file, as a repo-relative path; undefined without files. */
export const areaFor = (world: WorldFile, files: string[]) =>
  files.length ? areaOf(world, files[0]!) : undefined;
/** Writes `.herald/world.json` derived from two directory levels; undefined if it exists. */
export async function initWorld(root: string, force = false) {
  const world = deriveWorld(await directories(root), basename(root));
  await mkdir(join(root, '.herald'), { recursive: true });
  const text = JSON.stringify(world, null, 2) + '\n';
  try {
    await writeFile(join(root, worldPath), text, { flag: force ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  return world;
}
