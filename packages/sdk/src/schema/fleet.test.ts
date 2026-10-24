import { describe, expect, it } from 'vitest';
import {
  areaOf,
  deriveWorld,
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
  it('defaults kinds and drops unknown keys', () => {
    const w = worldFileSchema.parse({
      future: 1,
      areas: [{ id: 'a', label: 'A', kind: 'castle', paths: ['a/'], extra: true }],
    });
    expect(w.areas[0]).toEqual({ id: 'a', label: 'A', kind: 'other', paths: ['a/'], near: [] });
    expect('future' in w).toBe(false);
  });
  it('refuses duplicate, reserved, dangling and stacked areas', () => {
    const area = (id: string, extra = {}) => ({ id, label: id, paths: ['x/'], ...extra });
    for (const areas of [
      [area('a'), area('a')],
      [area('outskirts')],
      [area('a', { near: ['b'] })],
      [area('a', { at: [1, 1] }), area('b', { at: [1, 1] })],
    ])
      expect(worldFileSchema.safeParse({ areas }).success).toBe(false);
  });
  it('derives a world from top-level directories', () => {
    const w = deriveWorld(['apps', 'docs', '.github', 'My Lib', 'my-lib'], 'Repo');
    expect(w.name).toBe('Repo');
    expect(w.areas.map((a) => [a.id, a.kind, a.paths[0]])).toEqual([
      ['apps', 'ui', 'apps/**'],
      ['docs', 'docs', 'docs/**'],
      ['my-lib', 'other', 'My Lib/**'],
    ]);
    expect(deriveWorld([]).areas[0]!.id).toBe('root');
  });
});

describe('fleet units', () => {
  it('reads newer unit states leniently', () => {
    expect(
      unitStateSchema.parse({ name: 'a', kind: 'Bad Kind', activity: 'flying', mood: 'x' }),
    ).toEqual({ name: 'a', kind: 'agent', activity: 'idle', files: [] });
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
