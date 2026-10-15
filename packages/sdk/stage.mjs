// Stages a publishable npm package in `<package>/dist/npm`: the public name, built files (or
// directories) and docs. Workspace dependencies are bundled, so the manifest drops them.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const repository = 'https://github.com/herald-run/sdk';

export function stage(directory, manifest, files) {
  const source = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const target = join(directory, 'dist', 'npm');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of [...files, 'README.md', 'LICENSE', '../../CHANGELOG.md'])
    cpSync(join(directory, file), join(target, basename(file)), { recursive: true });
  const pkg = {
    name: manifest.name,
    version: source.version,
    license: 'MIT',
    type: 'module',
    homepage: 'https://herald.run/docs/',
    repository: {
      type: 'git',
      url: `git+${repository}.git`,
      directory: relative(join(directory, '../..'), directory),
    },
    bugs: { url: `${repository}/issues` },
    engines: { node: '>=20' },
    ...manifest,
    files: [...files.map((file) => basename(file)), 'README.md', 'LICENSE', 'CHANGELOG.md'],
    dependencies: Object.fromEntries(
      Object.entries(source.dependencies || {}).filter(
        ([, version]) => !version.startsWith('workspace:'),
      ),
    ),
  };
  writeFileSync(join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  return target;
}
