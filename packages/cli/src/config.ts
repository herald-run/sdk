import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatToken } from '@herald-run/sdk/e2ee';
import type { Saved } from './login';
export const defaultUrl = 'https://app.herald.run';
/**
 * Tokens live per profile and server host: the default profile keeps the original
 * `~/.config/herald/<host>.json`; named profiles use `profiles/<name>/<host>.json` and remember
 * their server in `profiles.json`.
 */
export type Profiles = Record<string, { url?: string }>;
export const configDirectory = (home: string) => join(home, '.config', 'herald');
export function profileName(value?: string) {
  const name = value || 'default';
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(name))
    throw new Error('Profile names use letters, digits, - and _ (up to 40).');
  return name;
}
export const tokenPath = (directory: string, profile: string, host: string) =>
  profile === 'default'
    ? join(directory, host + '.json')
    : join(directory, 'profiles', profile, host + '.json');
async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}
export const readProfiles = (directory: string) =>
  readJson<Profiles>(join(directory, 'profiles.json'), {});
export const readSaved = (path: string) => readJson<Saved>(path, {});
/** The token a client uses: keyed (`hdr_<auth>.<seed>.<fingerprint>`) when the login stored keys. */
export const savedToken = (saved: Saved) =>
  saved.token && saved.seed && saved.fingerprint
    ? formatToken(saved.token, saved.seed, saved.fingerprint)
    : saved.token;
async function writePrivate(directory: string, path: string, value: unknown) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
}
export async function saveLogin(
  directory: string,
  profile: string,
  host: string,
  url: string,
  saved: Saved,
) {
  await writePrivate(directory, tokenPath(directory, profile, host), saved);
  if (profile === 'default') return;
  const profiles = await readProfiles(directory);
  profiles[profile] = { url };
  await writePrivate(directory, join(directory, 'profiles.json'), profiles);
}
export const removeLogin = (path: string) => rm(path, { force: true });
