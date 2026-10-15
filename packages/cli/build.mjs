import { build } from 'esbuild';
import { stage } from '../sdk/stage.mjs';
// Bundles the SDK; ws and zod stay npm dependencies.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/herald.js',
  external: ['ws', 'zod'],
  banner: { js: '#!/usr/bin/env node' },
});
stage(
  import.meta.dirname,
  {
    name: '@herald-run/cli',
    homepage: 'https://herald.run/docs/cli/',
    description: 'Command line client for Herald, the human-in-the-loop inbox for agents',
    bin: { herald: 'herald.js' },
  },
  ['dist/herald.js', 'skills'],
);
