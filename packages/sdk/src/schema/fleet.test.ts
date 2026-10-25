import { describe, expect, it } from 'vitest';
import {
  areaOf,
  areaTrail,
  deriveWorld,
  flattenAreas,
  globMatch,
  unitBatchSchema,
  unitStateSchema,
  worldFileSchema,
} from './fleet';

const world = worldFileSchema.parse({
  areas: [
    { id: 'server', label: 'Server', kind: 'service', paths: ['src/server/**'] },
    { id: 'docs', label: 'Docs', paths: ['docs/', '**/*.md'] },
    { id: 'web', label: 'Web', kind: 'ui', paths: ['src/web/*.ts', 'lib/ui/?/x'] },
  ],
});

describe('fleet world files', () => {
  it('matches globs in file order', () => {
    expect(areaOf(world, 'src/server/index.ts')).toBe('server');
    expect(areaOf(world, 'src/server/README.md')).toBe('server');
    expect(areaOf(world, 'README.md')).toBe('docs');
    expect(areaOf(world, './docs/a/b.txt')).toBe('docs');
    expect(areaOf(world, 'src/web/app.ts')).toBe('web');
    expect(areaOf(world, 'src/web/lib/app.ts')).toBe('outskirts');
    expect(areaOf(world, 'lib/ui/a/x')).toBe('web');
    expect(areaOf(world, 'lib/ui/ab/x')).toBe('outskirts');
  });
  it('matches globs literally and by segment', () => {
    expect(globMatch('a+b/(c).ts', 'a+b/(c).ts')).toBe(true);
    expect(globMatch('a.ts', 'abts')).toBe(false);
    expect(globMatch('**/x/**', 'x/y')).toBe(true);
    expect(globMatch('a/**/b', 'a/b')).toBe(true);
    expect(globMatch('a/**/b', 'a/1/2/b')).toBe(true);
    expect(globMatch('a/**', 'a')).toBe(false);
    expect(globMatch('a*/b?', 'ax/bc')).toBe(true);
    expect(globMatch('a*', 'a/b')).toBe(false);
  });
  it('matches pathological globs fast', () => {
    const start = performance.now();
    const glob = `${'*a'.repeat(30)}*b`;
    expect(globMatch(glob, 'a'.repeat(250))).toBe(false);
    expect(globMatch(`${'**/'.repeat(30)}b`, `${'a/'.repeat(250)}c`)).toBe(false);
    expect(performance.now() - start).toBeLessThan(200);
  });
  it('picks the deepest area, children before their parent', () => {
    const w = worldFileSchema.parse({
      areas: [
        { id: 'md', label: 'Md', paths: ['*.md'] },
        {
          id: 'apps',
          label: 'Apps',
          paths: ['apps/**'],
          areas: [
            { id: 'site', label: 'Site', paths: ['apps/site/**'] },
            {
              id: 'srv',
              label: 'Server',
              areas: [{ id: 'api', label: 'API', paths: ['apps/srv/api/**'] }],
            },
          ],
        },
        { id: 'docs', label: 'Docs', paths: ['**/*.md'] },
      ],
    });
    expect(areaOf(w, 'README.md')).toBe('md');
    expect(areaOf(w, 'apps/site/README.md')).toBe('site');
    expect(areaOf(w, 'apps/srv/api/x.ts')).toBe('api');
    expect(areaOf(w, 'apps/srv/x.ts')).toBe('apps');
    expect(areaOf(w, 'docs/a.md')).toBe('docs');
    expect(areaOf(w, 'lib/x.ts')).toBe('outskirts');
    expect(flattenAreas(w).map((a) => [a.area.id, a.parent, a.depth])).toEqual([
      ['md', undefined, 1],
      ['apps', undefined, 1],
      ['site', 'apps', 2],
      ['srv', 'apps', 2],
      ['api', 'srv', 3],
      ['docs', undefined, 1],
    ]);
    expect(areaTrail(w, 'api')).toEqual(['apps', 'srv', 'api']);
    expect(areaTrail(w, 'nope')).toEqual([]);
  });
  it('defaults kinds and paths and drops unknown keys', () => {
    const w = worldFileSchema.parse({
      future: 1,
      areas: [
        { id: 'a', label: 'A', kind: 'castle', paths: ['a/'], extra: true, at: [1, 1] },
        { id: 'g', label: 'G', areas: [{ id: 'b', label: 'B', paths: ['b/'] }] },
      ],
    });
    expect(w.areas[0]).toEqual({ id: 'a', label: 'A', kind: 'other', paths: ['a/'] });
    expect(w.areas[1]!.paths).toEqual([]);
    expect('future' in w).toBe(false);
  });
  it('refuses duplicate, reserved, pathless, deep and oversized trees', () => {
    const area = (id: string, extra = {}) => ({ id, label: id, paths: ['x/'], ...extra });
    const nest = (n: number): object => area(`d${n}`, n > 1 ? { areas: [nest(n - 1)] } : {});
    const many = (n: number, p = 'a') => Array.from({ length: n }, (_, i) => area(`${p}${i}`));
    expect(worldFileSchema.safeParse({ areas: [nest(3)] }).success).toBe(true);
    for (const areas of [
      [area('a'), area('a')],
      [area('a', { areas: [area('a')] })],
      [area('outskirts')],
      [{ id: 'a', label: 'a' }],
      [area('a', { paths: [], areas: [] })],
      [nest(4)],
      many(17),
      [area('a', { areas: many(17) })],
      Array.from({ length: 8 }, (_, i) => area(`g${i}`, { areas: many(16, `c${i}-`) })),
    ])
      expect(worldFileSchema.safeParse({ areas }).success).toBe(false);
  });
  it('derives a world from two directory levels', () => {
    const w = deriveWorld(
      [
        'apps',
        'apps/site',
        'apps/api',
        'apps/.cache',
        'docs',
        'docs/img',
        '.github',
        'My Lib',
      ].concat(['my-lib', 'pkgs/docs', 'pkgs/Zed']),
      'Repo',
    );
    expect(w.name).toBe('Repo');
    expect(flattenAreas(w).map((a) => [a.area.id, a.area.kind, a.area.paths[0]])).toEqual([
      ['apps', 'ui', 'apps/**'],
      ['api', 'service', 'apps/api/**'],
      ['site', 'ui', 'apps/site/**'],
      ['docs', 'docs', 'docs/**'],
      ['my-lib', 'other', 'My Lib/**'],
      ['pkgs', 'other', 'pkgs/**'],
      ['pkgs-docs', 'docs', 'pkgs/docs/**'],
      ['zed', 'other', 'pkgs/Zed/**'],
    ]);
    expect(deriveWorld([]).areas[0]!.id).toBe('root');
    expect(deriveWorld(['x'.repeat(250)]).areas[0]!.id).toBe('root');
  });
  it('keeps derived worlds within the limits', () => {
    const dirs = Array.from({ length: 20 }, (_, i) =>
      Array.from({ length: 20 }, (_, j) => `d${i}/s${j}`),
    ).flat();
    const w = deriveWorld(dirs);
    expect(w.areas).toHaveLength(16);
    expect(w.areas[0]!.areas).toHaveLength(7);
    expect(flattenAreas(w).length).toBeLessThanOrEqual(128);
  });
});

describe('fleet units', () => {
  it('reads newer unit states leniently', () => {
    expect(
      unitStateSchema.parse({ name: 'a', kind: 'Bad Kind', activity: 'flying', mood: 'x' }),
    ).toEqual({ name: 'a', kind: 'agent', activity: 'idle', files: [] });
  });
  it('trims squads and checks parent keys', () => {
    expect(unitStateSchema.parse({ name: 'a', squad: '  run 7 ', parent: 'cc-1' })).toMatchObject({
      squad: 'run 7',
      parent: 'cc-1',
    });
    expect(unitStateSchema.safeParse({ name: 'a', squad: 'x'.repeat(61) }).success).toBe(false);
    expect(unitStateSchema.safeParse({ name: 'a', squad: ' ' }).success).toBe(false);
    expect(unitStateSchema.safeParse({ name: 'a', parent: 'not a key' }).success).toBe(false);
  });
  it('refuses duplicate keys in a batch', () => {
    const sealed = {
      v: 1,
      ctx: { t: 'fleet-unit', account: 'a' },
      from: 'k'.repeat(22),
      to: [{ kid: 'k'.repeat(22), enc: 'e'.repeat(43), key: 'x' }],
      iv: 'i'.repeat(16),
      ct: 'c'.repeat(22),
      sig: 's'.repeat(86),
    };
    expect(unitBatchSchema.safeParse({ units: [{ key: 'a', sealed }] }).success).toBe(true);
    expect(
      unitBatchSchema.safeParse({
        units: [
          { key: 'a', sealed },
          { key: 'a', sealed },
        ],
      }).success,
    ).toBe(false);
  });
});
