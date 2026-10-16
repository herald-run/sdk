# Changelog

Client packages: `@herald-run/sdk`, `@herald-run/cli`, `@herald-run/mcp` and the `herald-run` Python package. Compatibility policy: https://herald.run/docs/api/.

## Unreleased

- Content is always end-to-end encrypted; tokens without a key are refused. Connection tokens have the form `hdr_<auth>.<seed>.<fingerprint>` (from `herald login` or Settings → Connections); the SDKs encrypt what they send and decrypt what they read: messages, forms, answers, tasks, logs, results, files, secrets and secret offers. Only `hdr_<auth>` is sent to the server. If the account's keys are missing or do not match the token, content calls fail; nothing falls back to plaintext.
- SDKs: decrypted records carry `e2ee: true`; records this connection cannot decrypt carry `locked: true`, and unsealed or forged ones `unverified: true`, with their content withheld. Leading or trailing whitespace in a token is ignored. New `keys()`, `safetyCode()` / `safety_code()` for the 30-digit account safety code, `openTask()` / `open_task()` for webhook tasks, `deviceCertificate()`, and a required `certificate` on `createIntegration()`. Failed tasks may carry `reason` (`webhook-unavailable`, `not-acknowledged`, `lease-lapsed`). Uploads return the attachment with its file `key`; `download()` takes that attachment, or an ID of a file seen in an opened record. `revealSecrets()` takes no private key. The `keyed` getter is gone.
- CLI: `herald login` certifies a key for the device once you confirm that the account safety code matches the approval page (`--safety-code CODE` outside a terminal); open Herald on a signed-in device first to set up the account's keys. `whoami` and `status` show the safety code. `download` needs `--message ID`. `messages --search` and `search` filter the newest five decrypted pages locally, since the server cannot search encrypted content. Older logins without a key must log in again.
- MCP: uses keyed CLI logins; `download_file` needs the `messageId` of the message holding the file.
- Secret file fields: `{type: "file", secret: true}` (JSON Schema `x-herald-type: secret-file`) send the uploads to the asking connection only, like secrets; Herald deletes them 15 minutes after the answer. `revealSecrets()` / `reveal_secrets()` return their attachments, ready for `download()`. CLI `request-file --out PATH` and MCP `request_file` write one requested file to a new 0600 file and print only the ID and status, refusing answers from apps that would keep the file in history; the `herald-get-file` skill uses them.

## 0.3.0-beta.3

- CLI: `integrate claude-code|codex` works with `--profile`, `--url` and `HERALD_PROFILE`, and re-registers the MCP server when they change.

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
