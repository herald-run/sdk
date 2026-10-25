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
const glob = z.string().min(1).max(200);
/** A world area; groups hold `areas` and may keep `paths` as their subtree's catch-all. */
export interface Area {
  id: string;
  label: string;
  kind: AreaKind;
  /** Repo-relative globs (`**`, `*`, `?`); a trailing `/` means everything below. */
  paths: string[];
  areas?: Area[];
}
type AreaInput = {
  id: string;
  label: string;
  kind?: unknown;
  paths?: string[];
  areas?: AreaInput[];
};
/** Nesting, child and node limits; top-level areas are depth 1. */
export const worldLimits = { depth: 3, children: 16, nodes: 128 } as const;
export const areaSchema: z.ZodType<Area, AreaInput> = z
  .object({
    id: areaId,
    label: z.string().trim().min(1).max(60),
    kind: z.enum(areaKinds).catch('other'),
    paths: z.array(glob).max(20).default([]),
    areas: z.lazy(() => z.array(areaSchema).max(worldLimits.children)).optional(),
  })
  .refine((a) => a.areas?.length || a.paths.length, 'A leaf area needs a path.');
/** Every area in preorder, with its parent's ID and its depth (top level: 1). */
export function flattenAreas(world: { areas: Area[] }) {
  const out: { area: Area; parent?: string; depth: number }[] = [];
  const walk = (areas: Area[], depth: number, parent?: string) => {
    for (const area of areas) {
      out.push({ area, depth, ...(parent ? { parent } : {}) });
      if (area.areas) walk(area.areas, depth + 1, area.id);
    }
  };
  walk(world.areas, 1);
  return out;
}
/** The IDs from a top-level area down to `id` (inclusive); empty when no area has it. */
export function areaTrail(world: { areas: Area[] }, id: string): string[] {
  const find = (areas: Area[]): string[] => {
    for (const a of areas) {
      if (a.id === id) return [a.id];
      const below = a.areas ? find(a.areas) : [];
      if (below.length) return [a.id, ...below];
    }
    return [];
  };
  return find(world.areas);
}
/**
 * A repo's world file: a tree of areas. Unknown keys are dropped so newer files still parse;
 * `render` holds renderer-specific hints that other renderers ignore.
 */
export const worldFileSchema = z
  .object({
    version: z.number().int().min(1).default(1),
    name: z.string().trim().min(1).max(80).optional(),
    areas: z.array(areaSchema).min(1).max(worldLimits.children),
    render: z.record(z.string().max(40), z.record(z.string(), z.unknown())).optional(),
  })
  .superRefine((w, ctx) => {
    const all = flattenAreas(w);
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (all.length > worldLimits.nodes) issue(`A world has at most ${worldLimits.nodes} areas.`);
    if (all.some((a) => a.depth > worldLimits.depth))
      issue(`Areas nest at most ${worldLimits.depth} deep.`);
    const ids = new Set(all.map((a) => a.area.id));
    if (ids.size !== all.length) issue('Area IDs must be unique.');
    if (ids.has(outskirts)) issue(`"${outskirts}" is reserved.`);
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
/**
 * The area owning a repo-relative path: depth-first in file order, children before their
 * parent's own globs, so the deepest match wins; else `outskirts`.
 */
export function areaOf(world: WorldFile, path: string): string {
  const p = path.replace(/^\.?\/+/, '');
  const find = (areas: Area[]): string | undefined => {
    for (const a of areas) {
      const hit = (a.areas && find(a.areas)) || (a.paths.some((g) => globMatch(g, p)) && a.id);
      if (hit) return hit;
    }
  };
  return find(world.areas) ?? outskirts;
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
const kindOf = (dir: string) => kindHints.find(([re]) => re.test(dir.toLowerCase()))?.[1];
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
const sorted = (names: Iterable<string>) =>
  [...new Set(names)]
    .filter((d) => d && !d.startsWith('.'))
    .map((d) => [d.toLowerCase(), d] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, d]) => d);
/**
 * A world for repos without a world file, from directory paths up to two levels deep (`apps`,
 * `apps/site`; dot directories skipped). A top-level directory with 2+ subdirectories becomes a
 * group with one child each; the others are leaves.
 */
export function deriveWorld(dirs: string[], name?: string): WorldFile {
  const subs = new Map<string, string[]>();
  for (const d of dirs) {
    const [top, sub] = d.replace(/^\.?\/+|\/+$/g, '').split('/');
    // Globs over 200 characters would not parse.
    if (!top || `${top}/${sub ?? ''}/**`.length > 200) continue;
    if (!subs.has(top)) subs.set(top, []);
    if (sub) subs.get(top)!.push(sub);
  }
  const used = new Set<string>([outskirts]);
  const claim = (...ids: string[]) => {
    const id = ids.find((i) => i && !used.has(i));
    if (id) used.add(id);
    return id;
  };
  const top: { dir: string; id: string; kind: AreaKind; subs: string[] }[] = [];
  for (const dir of sorted(subs.keys())) {
    const id = top.length < worldLimits.children && claim(slug(dir));
    if (id) top.push({ dir, id, kind: kindOf(dir) ?? 'other', subs: sorted(subs.get(dir)!) });
  }
  const groups = top.filter((t) => t.subs.length >= 2).length;
  const per = Math.min(
    worldLimits.children,
    Math.floor((worldLimits.nodes - top.length) / Math.max(groups, 1)),
  );
  const areas = top.map(({ dir, id, kind, subs }): Area => {
    const leaf = { id, label: dir.slice(0, 60), kind, paths: [`${dir}/**`] };
    if (subs.length < 2) return leaf;
    const children = subs.slice(0, per).flatMap((sub) => {
      const child = claim(slug(sub), slug(`${id}-${sub}`));
      const paths = [`${dir}/${sub}/**`];
      return child
        ? [{ id: child, label: sub.slice(0, 60), kind: kindOf(sub) ?? kind, paths }]
        : [];
    });
    return children.length ? { ...leaf, areas: children } : leaf;
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
export const unitKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
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
  /** A group label, e.g. the orchestrator's run. */
  squad: z.string().trim().min(1).max(60).optional(),
  /** The unit key of the orchestrator that runs this one. */
  parent: unitKeySchema.optional(),
});
export type UnitState = z.infer<typeof unitStateSchema>;
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
  /** The world file at this ref, or one derived from its first two directory levels (`derived`). */
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
/**
 * `GET /fleet/worlds/:id`: refs. `?limit=1-500` adds a page of units by key (`units`) and, when
 * more follow, `next` for `?cursor=`. Viewer sockets get the units as `snapshot` frames instead.
 */
export interface FleetWorldDetail extends FleetWorld {
  refs: FleetRef[];
  units?: FleetUnit[];
  next?: string;
  /** Set when the plan's unit-hours are used up; reporters get 429 `FLEET_QUOTA` until it resets. */
  paused?: boolean;
}
/**
 * Frames a viewer socket (`/fleet/ws?world=ID`) receives. It opens with every unit in `snapshot`
 * frames of up to 100 (`done` on the last), before live ones. `units` and `gone` are coalesced:
 * each key's latest state, about every 500 ms. `refs` means refetch the world.
 */
export type FleetFrame =
  | { type: 'snapshot'; units: FleetUnit[]; done: boolean }
  | { type: 'units'; units: FleetUnit[] }
  | { type: 'gone'; keys: string[] }
  | { type: 'refs' }
  | { type: 'paused'; paused: boolean };
/**
 * Frames a reporter socket receives: a refused frame's `error`, or `sync` when a viewer joins,
 * asking it to re-send its live units with `persist: false`.
 */
export type FleetReporterFrame =
  | { type: 'error'; error: string; code?: string; retryAfter?: number; resetsAt?: string }
  | { type: 'sync' };
