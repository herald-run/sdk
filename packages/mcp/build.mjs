import { build } from 'esbuild';
import { stage } from '../sdk/stage.mjs';
// Bundles the SDK and CLI helpers; npm dependencies stay external.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/herald-mcp.js',
  external: ['ws', 'zod', '@modelcontextprotocol/sdk'],
  banner: { js: '#!/usr/bin/env node' },
});
stage(
  import.meta.dirname,
  {
    name: '@herald-run/mcp',
    homepage: 'https://herald.run/docs/agents/',
    description: 'MCP server for Herald, the human-in-the-loop inbox for agents',
    bin: { 'herald-mcp': 'herald-mcp.js' },
  },
  ['dist/herald-mcp.js'],
);
