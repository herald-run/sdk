# Herald SDKs

Clients for [Herald](https://herald.run), the human-in-the-loop inbox for agents: send messages, ask for approvals, run tasks, and move files and secrets.

| Package                        | Install                        | Source                               |
| ------------------------------ | ------------------------------ | ------------------------------------ |
| TypeScript SDK and API schemas | `npm install @herald-run/sdk`  | [`packages/sdk`](packages/sdk)       |
| CLI                            | `npx @herald-run/cli --help`   | [`packages/cli`](packages/cli)       |
| MCP server                     | `npx @herald-run/mcp`          | [`packages/mcp`](packages/mcp)       |
| Python SDK                     | `pip install --pre herald-run` | [`packages/python`](packages/python) |

Examples live in [`examples`](examples). Documentation: [herald.run/docs](https://herald.run/docs/).

## Development

Node.js 24 with pnpm, and Python 3.11 or later.

```sh
pnpm install
pnpm fmt && pnpm lint && pnpm types && pnpm test
pnpm test:python   # after: pip install -e packages/python
```

`packages/sdk/fixtures/contracts.json` is the API contract both SDKs replay; change it together with the clients. See [CHANGELOG.md](CHANGELOG.md) for releases and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

MIT
