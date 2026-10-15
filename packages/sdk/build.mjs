import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { stage } from './stage.mjs';
// `schema` and `crypto` are browser-safe subpaths; shared code lands in chunk files.
const entries = {
  index: 'src/index.ts',
  schema: 'src/schema/index.ts',
  crypto: 'src/schema/crypto.ts',
};
await build({
  entryPoints: entries,
  bundle: true,
  splitting: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'dist',
  chunkNames: 'chunk-[hash]',
  external: ['ws', 'zod'],
});
for (const [name, entry] of Object.entries(entries))
  execFileSync(
    'dts-bundle-generator',
    ['-o', `dist/${name}.d.ts`, entry, '--project', 'tsconfig.build.json', '--no-banner'],
    { stdio: 'inherit', shell: false },
  );
const files = (await import('node:fs'))
  .readdirSync('dist')
  .filter((file) => /\.(js|d\.ts)$/.test(file))
  .map((file) => 'dist/' + file);
stage(
  import.meta.dirname,
  {
    name: '@herald-run/sdk',
    homepage: 'https://herald.run/docs/sdk/',
    description: 'TypeScript client for Herald, the human-in-the-loop inbox for agents',
    exports: Object.fromEntries(
      Object.keys(entries).map((name) => [
        name === 'index' ? '.' : './' + name,
        { types: `./${name}.d.ts`, default: `./${name}.js` },
      ]),
    ),
    main: './index.js',
    types: './index.d.ts',
    sideEffects: false,
  },
  files,
);
