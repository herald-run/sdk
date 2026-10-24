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
/** Top-level directories git tracks, else those on disk (dot directories are skipped later). */
export async function topDirectories(root: string): Promise<string[]> {
  const tracked = await git(root, ['ls-tree', '-d', '--name-only', 'HEAD']);
  if (tracked !== undefined) return tracked.split('\n').filter(Boolean);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && e.name !== 'node_modules').map((e) => e.name);
}
/** The checkout's world file, or one derived from its top-level directories. */
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
  return deriveWorld(await topDirectories(root), basename(root));
}
/** The area of the first file, as a repo-relative path; undefined without files. */
export const areaFor = (world: WorldFile, files: string[]) =>
  files.length ? areaOf(world, files[0]!) : undefined;
/** Writes `.herald/world.json` derived from the top-level directories; false if it exists. */
export async function initWorld(root: string, force = false) {
  const world = deriveWorld(await topDirectories(root), basename(root));
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
