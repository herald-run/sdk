import { homedir } from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { version } from '@herald-run/sdk';
import { connect } from './auth';
import { createServer } from './server';
const flag = process.argv[2];
if (flag === '--version') console.log(version);
else if (flag) {
  console.error('herald-mcp is a stdio MCP server; run it from an MCP client. Options: --version');
  process.exitCode = 2;
} else
  await createServer(() => connect(process.env, homedir())).connect(new StdioServerTransport());
