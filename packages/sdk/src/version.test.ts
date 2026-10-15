import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { version } from './version';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
it('keeps the SDK, CLI, MCP and Python versions in step', () => {
  expect(JSON.parse(read('../package.json')).version).toBe(version);
  expect(JSON.parse(read('../../cli/package.json')).version).toBe(version);
  expect(JSON.parse(read('../../mcp/package.json')).version).toBe(version);
  // PEP 440 spells 0.3.0-beta.1 as 0.3.0b1.
  const python = read('../../python/herald/_version.py').match(/"(.+)"/)![1];
  const pep440 = { alpha: 'a', beta: 'b', rc: 'rc' } as Record<string, string>;
  expect(python).toBe(version.replace(/-(alpha|beta|rc)\.(\d+)$/, (_, t, n) => pep440[t] + n));
  expect(read('../../../CHANGELOG.md')).toContain(`## ${version}`);
});
