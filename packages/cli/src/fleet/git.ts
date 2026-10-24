import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
/** A repo checkout as Fleet reporters see it. */
export type Checkout = { root: string; branch?: string; repo?: string };
/** `owner/repo` from a GitHub remote: HTTPS, SSH (`<user>@github.com:owner/repo.git`) or `ssh://` forms. */
export function parseRemote(url: string): string | undefined {
  const m = url
    .trim()
    .match(
      /^(?:(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/\s]+@)?github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
    );
  return m ? `${m[1]}/${m[2]}` : undefined;
}
/** Runs git with a short timeout; undefined on any failure. */
export const git = (cwd: string, args: string[], timeout = 1500) =>
  new Promise<string | undefined>((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim()),
    );
  });
/** The git root, branch (none when detached) and GitHub `owner/repo` of `cwd`, if a checkout. */
export async function checkout(cwd: string): Promise<Checkout | undefined> {
  const out = await git(cwd, ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD']);
  const [root, branch] = out?.split('\n') ?? [];
  if (!root) return undefined;
  const remote = await git(root, ['remote', 'get-url', 'origin']);
  return {
    root,
    ...(branch && branch !== 'HEAD' ? { branch } : {}),
    ...(remote && parseRemote(remote) ? { repo: parseRemote(remote) } : {}),
  };
}
/** A short stable hash for unit keys. */
export const shortHash = (...parts: string[]) =>
  createHash('sha256').update(parts.join('\0')).digest('base64url').slice(0, 22);
