import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { unitKeySchema, type UnitState } from '@herald-run/sdk/schema';
/** One local update for the daemon (a JSON line on its socket) or the HTTP fallback. */
export const updateSchema = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    key: unitKeySchema,
    ttl: z.number().int().min(30).max(3600).optional(),
    state: z.record(z.string(), z.unknown()).optional(),
    remove: z.literal(true).optional(),
  })
  .strict();
export type FleetUpdate = Omit<z.infer<typeof updateSchema>, 'state'> & {
  state?: Partial<UnitState>;
};
/** Recent files kept per unit. */
const RECENT = 5;
/** Later fields win; files keep the most recent few, newest first. */
export function mergeState(
  prev: Partial<UnitState> = {},
  next: Partial<UnitState> = {},
): Partial<UnitState> {
  const defined = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
  const files = next.files?.length
    ? [...new Set([...next.files, ...(prev.files ?? [])])].slice(0, RECENT)
    : prev.files;
  return { ...prev, ...defined, ...(files ? { files } : {}) };
}
const suffix = (profile: string) => (profile === 'default' ? '' : '-' + profile);
/** Per-user runtime directory, else the Herald config directory. */
export const socketPath = (
  env: Record<string, string | undefined>,
  config: string,
  profile: string,
) => join(env.XDG_RUNTIME_DIR || config, `herald-fleet${suffix(profile)}.sock`);
/** The hook's throttle state: per-user runtime directory, else the temp directory. */
export const hookStatePath = (env: Record<string, string | undefined>, profile: string) =>
  env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, `herald-fleet-hook${suffix(profile)}.json`)
    : join(tmpdir(), `herald-fleet-hook-${process.getuid?.() ?? 'user'}${suffix(profile)}.json`);
/** Hands an update to a running daemon; false when none answers within `timeout` ms. */
export const toDaemon = (path: string, update: FleetUpdate, timeout = 300) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => done(false), timeout);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    socket.on('error', () => done(false));
    socket.on('connect', () => socket.end(JSON.stringify(update) + '\n', () => done(true)));
  });
