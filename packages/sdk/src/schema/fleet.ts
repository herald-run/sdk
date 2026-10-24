import { z } from 'zod';
import { sealedEnvelopeSchema, type SealedEnvelope } from './e2ee';
// Fleet: each repo is a world of areas (`.herald/world.json`); agents report live units.

const areaId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
/** Unmatched paths belong here; a world file cannot define it. */
export const outskirts = 'outskirts';
export const worldPath = '.herald/world.json';
export const areaKinds = [
  'service',
  'ui',
  'data',
  'infra',
  'docs',
  'tests',
  'tooling',
  'other',
] as const;
export type AreaKind = (typeof areaKinds)[number];
const cell = z.number().int().min(0).max(63);
export const areaSchema = z.object({
  id: areaId,
  label: z.string().trim().min(1).max(60),
  kind: z.enum(areaKinds).catch('other'),
  /** Repo-relative globs (`**`, `*`, `?`); a trailing `/` means everything below. */
  paths: z.array(z.string().min(1).max(200)).min(1).max(20),
  /** A cell on an abstract grid; areas without one are placed beside `near`. */
  at: z.tuple([cell, cell]).optional(),
  near: z.array(areaId).max(8).default([]),
});
export type Area = z.infer<typeof areaSchema>;
/**
 * A repo's world file. Unknown keys are dropped so newer files still parse; `render` holds
 * renderer-specific hints that other renderers ignore.
 */
export const worldFileSchema = z
  .object({
    version: z.number().int().min(1).default(1),
    name: z.string().trim().min(1).max(80).optional(),
    areas: z.array(areaSchema).min(1).max(64),
    render: z.record(z.string().max(40), z.record(z.string(), z.unknown())).optional(),
  })
  .superRefine((w, ctx) => {
    const ids = new Set(w.areas.map((a) => a.id));
    if (ids.size !== w.areas.length)
      ctx.addIssue({ code: 'custom', message: 'Area IDs must be unique.' });
    if (ids.has(outskirts))
      ctx.addIssue({ code: 'custom', message: `"${outskirts}" is reserved.` });
    if (w.areas.some((a) => a.near.some((n) => !ids.has(n))))
      ctx.addIssue({ code: 'custom', message: '`near` must name areas of this world.' });
    const cells = w.areas.flatMap((a) => (a.at ? [a.at.join(',')] : []));
    if (new Set(cells).size !== cells.length)
      ctx.addIssue({ code: 'custom', message: 'Two areas share a cell.' });
  });
export type WorldFile = z.infer<typeof worldFileSchema>;
/** World files larger than this are refused. */
export const worldFileBytes = 64 * 1024;

/** Wildcard match of one path segment; `*` and `?` never cross `/`. O(|glob|·|seg|). */
function segMatch(g: string, s: string): boolean {
  let gi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (gi < g.length && (g[gi] === '?' || g[gi] === s[si])) {
      gi++;
      si++;
    } else if (gi < g.length && g[gi] === '*') {
      star = gi++;
      mark = si;
    } else if (star >= 0) {
      gi = star + 1;
      si = ++mark;
    } else return false;
  }
  while (g[gi] === '*') gi++;
  return gi === g.length;
}
/**
 * Whether a repo-relative path matches a glob, in time bounded by |glob|·|path|. A segment of
 * just `**` spans zero or more directories (one or more files when last); `*` and `?` stay within
 * a segment, as does `**` inside one; a trailing `/` matches everything below.
 */
export function globMatch(glob: string, path: string): boolean {
  const g = glob
    .replace(/^\.?\/+/, '')
    .replace(/\/$/, '/**')
    .split('/');
  const p = path.split('/');
  const n = p.length;
  // next[j]: g[i+1..] matches p[j..]; filled backwards so each pair is tried once.
  let next = new Uint8Array(n + 1);
  next[n] = 1;
  for (let i = g.length - 1; i >= 0; i--) {
    const cur = new Uint8Array(n + 1);
    const last = i === g.length - 1;
    if (g[i] === '**') {
      if (!last) cur[n] = next[n]!;
      for (let j = n - 1; j >= 0; j--) cur[j] = last || next[j] || cur[j + 1] ? 1 : 0;
    } else for (let j = n - 1; j >= 0; j--) cur[j] = next[j + 1] && segMatch(g[i]!, p[j]!) ? 1 : 0;
    next = cur;
  }
  return next[0] === 1;
}
/** The area owning a repo-relative path: the first with a matching glob, else `outskirts`. */
export function areaOf(world: WorldFile, path: string): string {
  const p = path.replace(/^\.?\/+/, '');
  for (const area of world.areas) if (area.paths.some((g) => globMatch(g, p))) return area.id;
  return outskirts;
}
const kindHints: [RegExp, AreaKind][] = [
  [/^(docs?|documentation)$/, 'docs'],
  [/^(tests?|e2e|spec|__tests__)$/, 'tests'],
  [/^(infra|deploy|ops|terraform|k8s|helm|\.github)$/, 'infra'],
  [/^(scripts|tools|bin|dev)$/, 'tooling'],
  [/^(web|ui|frontend|client|app|apps|site|website)$/, 'ui'],
  [/^(db|data|migrations|schema)$/, 'data'],
  [/^(server|api|backend|services?|src|lib|packages|pkg|cmd|internal)$/, 'service'],
];
/** A world for repos without a world file: one area per top-level directory (dotfiles skipped). */
export function deriveWorld(dirs: string[], name?: string): WorldFile {
  const used = new Set<string>([outskirts]);
  const areas = dirs
    .filter((d) => d && !d.startsWith('.'))
    .map((d) => [d.toLowerCase(), d] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, d]) => d)
    .slice(0, 64)
    .flatMap((dir) => {
      const id = dir
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      if (!id || used.has(id)) return [];
      used.add(id);
      const kind = kindHints.find(([re]) => re.test(dir.toLowerCase()))?.[1] ?? 'other';
      return [{ id, label: dir.slice(0, 60), kind, paths: [`${dir}/**`], near: [] }];
    });
  return worldFileSchema.parse({
    name,
    areas: areas.length ? areas : [{ id: 'root', label: 'Root', paths: ['**'] }],
  });
}

export const unitActivities = [
  'idle',
  'reading',
  'editing',
  'running',
  'waiting',
  'blocked',
  'done',
] as const;
export type UnitActivity = (typeof unitActivities)[number];
/** A unit's sealed state. Unknown keys are dropped so newer reporters still parse. */
export const unitStateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Picks the unit's type and portrait set: `claude-code`, `codex`, `ci`, `human`, … */
  kind: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
    .catch('agent'),
  /** The branch it works on; the default branch when omitted. */
  ref: z.string().min(1).max(255).optional(),
  area: areaId.optional(),
  activity: z.enum(unitActivities).catch('idle'),
  task: z.string().max(200).optional(),
  files: z.array(z.string().max(300)).max(10).default([]),
});
export type UnitState = z.infer<typeof unitStateSchema>;
export const unitKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** Serialized sealed unit envelopes larger than this are refused. */
export const unitEnvelopeChars = 6000;
/**
 * One unit write: its state sealed with `ctx {t:'fleet-unit', account, world, key}` (plus `team`
 * in team workspaces). `ttl` seconds without a write fade it to idle; it is removed after 24 h.
 */
export const unitInputSchema = z
  .object({
    key: unitKeySchema,
    ttl: z.number().int().min(30).max(3600).default(600),
    sealed: sealedEnvelopeSchema,
  })
  .strict()
  .refine((u) => JSON.stringify(u.sealed).length <= unitEnvelopeChars, 'Unit state is too large.');
export type UnitInput = z.input<typeof unitInputSchema>;
/** `POST /fleet/worlds/:id/units`, and a reporter socket's `units` frame. */
export const unitBatchSchema = z
  .object({ units: z.array(unitInputSchema).min(1).max(50) })
  .strict()
  .refine(
    (b) => new Set(b.units.map((u) => u.key)).size === b.units.length,
    'Unit keys must be unique.',
  );
/** A reporter socket frame; `persist: false` reaches live viewers without being stored. */
export const unitFrameSchema = z
  .object({
    type: z.literal('units'),
    units: z.array(unitInputSchema).min(1).max(50),
    persist: z.boolean().default(true),
  })
  .strict();
/** Tracks a branch that has no pull request: `PUT /fleet/worlds/:id/refs`. */
export const trackRefSchema = z.object({ ref: z.string().min(1).max(255) }).strict();

export interface FleetUnit {
  key: string;
  integrationId: string;
  sealed: SealedEnvelope;
  updatedAt: string;
  /** When it fades to idle; it is removed 24 h after its last write. */
  expiresAt: string;
}
export interface FleetPullRequest {
  number: number;
  title: string;
  url: string;
  draft: boolean;
}
/** A branch as the GitHub App saw it. Fleet repo data is not end-to-end encrypted. */
export interface FleetRef {
  ref: string;
  sha: string;
  default: boolean;
  /** The world file at this ref, or one derived from the top-level directories (`derived`). */
  world: WorldFile;
  derived: boolean;
  /** An invalid world file's error; `world` then falls back to the default branch's or a derived one. */
  error?: string;
  /** Paths changed against the default branch; `truncated` past 2,000. */
  changed: string[];
  truncated?: boolean;
  pr?: FleetPullRequest;
  updatedAt: string;
}
export interface FleetRepo {
  id: number;
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
}
export interface FleetWorld {
  id: string;
  repo: FleetRepo;
  createdAt: string;
}
/** `GET /fleet/worlds/:id`: refs and live units. */
export interface FleetWorldDetail extends FleetWorld {
  refs: FleetRef[];
  units: FleetUnit[];
  /** Set when the plan's unit-hours are used up; reporters get 429 `FLEET_QUOTA` until it resets. */
  paused?: boolean;
}
/** Frames a viewer socket (`/fleet/ws?world=ID`) receives. `refs` means refetch the world. */
export type FleetFrame =
  | { type: 'units'; units: FleetUnit[] }
  | { type: 'gone'; keys: string[] }
  | { type: 'refs' }
  | { type: 'paused'; paused: boolean };
