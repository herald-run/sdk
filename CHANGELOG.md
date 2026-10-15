# Changelog

Client packages: `@herald-run/sdk`, `@herald-run/cli`, `@herald-run/mcp` and the `herald-run` Python package. Compatibility policy: https://herald.run/docs/api/.

## 0.3.0-beta.2

- npm packages publish through trusted publishing (OIDC) with provenance; no code changes.

## 0.3.0-beta.1

- Published as `@herald-run/sdk`, `@herald-run/cli` (`npx @herald-run/cli`) and `herald-run` (import `herald`); Node.js 20+, Python 3.11+.
- CLI: human-readable output by default and `--json` for machine output; the input file flag is now `--input`/`-i` (was `--json`). Exit codes: 0 answered, 1 error, 2 usage, 3 expired, 4 cancelled.
- CLI: `--version`, `help <command>`, `completion`, `whoami`, `status`, `messages`/`search`, `show`, `wait`, `logs`, `download`, `account`, `destinations update|remove|rotate-secret`, `send --file`, profiles (`--profile`, `HERALD_PROFILE`), `logout` revokes the token, `login` opens the browser and asks no scope question, `listen --target KEY` finds the destination.
- SDKs: `HeraldError.code`, `User-Agent`, `ping`, `token`/`revokeToken`, `account`, `taskLogs`, `download`, `rotateDestinationSecret`. Python adds `create_keys`, `seal`/`unseal`, `reveal_secrets`, `verify_webhook` and the synchronous `SyncHerald`.
- `@herald-run/mcp`: MCP server (`herald-mcp`, stdio) with send, ask, wait, message, thread, file and secret tools; secrets are written to 0600 files, never returned.
- CLI: `integrate claude-code|codex [--scope user|project] [--dry-run]` installs Herald skills and registers the MCP server; idempotent.
- Docs at https://herald.run/docs with an OpenAPI 3.1 description at `/docs/openapi.json`, generated from the schemas in `@herald-run/sdk/schema`.
