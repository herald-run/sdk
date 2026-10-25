# Changelog

Client packages: `@herald-run/sdk`, `@herald-run/cli`, `@herald-run/mcp` and the `herald-run` Python package. Compatibility policy: https://herald.run/docs/api/.

## Unreleased

- Fleet (new minor): agents report what they work on as end-to-end encrypted units (`fleet-unit` envelopes bound to account, world and key, plus `team` in team workspaces). TypeScript `herald.fleet` (`worlds`, `world`, `report`, `remove`, `track`, and `reporter` sockets with jittered reconnect and a frame budget) and `KeyedSession.sealUnit`; Python `fleet_worlds`, `fleet_world`, `fleet_report`, `fleet_remove`, `fleet_track`. World files (`worldFileSchema`, `.herald/world.json`) are trees of areas up to 3 deep; `areaOf` picks the deepest match, with `flattenAreas`, `areaTrail` and `deriveWorld` (from two directory levels). States are validated with `unitStateSchema`; sealed states over 6,000 characters are refused. `HeraldError` carries `resetsAt` (Python `resets_at`) for paused quotas.
- CLI: `herald fleet init|worlds|report|hook|daemon`; `init` derives the world file from the tracked directories two levels deep. `hook` maps Claude Code hook events to unit activities, hands them to the daemon or reports over HTTP at most every 15 s, and always exits 0 silently; `daemon` coalesces updates on a private unix socket and reports them on one socket per world. `herald login` grants `fleet:write` by default; older logins need `herald login` again for Fleet.
- SDKs: while the live socket is open, `wait` (and Python `watch`) falls back to polling every 5 minutes instead of 30 s (30 s while it is down); TypeScript `wait` checks only on sync events newer than the last one it saw, and a check that overlaps an event runs once more.
- CLI: `herald listen` flushes task logs every 10 s instead of 2 s; a task's final logs still flush before its completion update.
- SDKs: team workspaces. Keyed clients verify the workspace succession chain and signed roster (pinned with `pin`/`onPin`, Python `pin`/`on_pin`), seal to the team key (`team` on send), accept answers only from verified team members (`answeredBy`, `response.by`) and reseal once on `409 E2EE_STALE_KEY`. Requests send `X-Herald-Client: sdk/<version>`; `workspace` sets `Herald-Workspace`. New schemas for team routing policies, member availability and update pushes; `e2ee` adds the workspace functions and vectors.
- CLI: `herald login --workspace SLUG`, `send`/`ask --team SLUG`; `show` prints the team and who answered; `whoami` shows the workspace and its teams.
- Team workspaces: roster members carry a signed `name`; invite links carry `#<secret>.<fingerprint>` (`inviteFragment`, `parseInviteFragment`) and join proofs bind that fingerprint; key wraps verify only under the chain head; `recertifyWorkspace` re-signs a certificate verified under the previous roster with its teams intersected; `keyringPin` keeps workspace anchors in the personal keyring without root swaps or downgrades. Keyed clients take a record's team only from a verified envelope or their own send, and only within their certified teams. Env-token clients read a pin from `HERALD_PIN`; the CLI keeps one current with `--pin-file FILE`.
- TypeScript SDK: the live socket sends a keepalive `ping` every 30 s and reconnects when one goes unanswered, so a silently dropped connection no longer leaves `wait` on the 5-minute poll.

## 0.3.0-beta.6

- CLI: `herald login` waits out rate limits (which a login pending a few minutes reached) and bodiless server errors, honouring `Retry-After`, instead of failing with "Login failed."; other failures show the server's message.
- CLI: the README points Claude Code and Codex at the skills, which run the CLI.
- Forms: `questions` input (the shape of Claude Code's AskUserQuestion) becomes required choice fields `q1`…`qN`; `questionAnswers` maps answers back by question text, and `fieldAnswers` does so from a request's fields. Fields gain `header` and `other` (free text instead of a choice); options gain `description` and Markdown `preview`.
- MCP `ask` takes `questions` and returns `answers`, as do `wait` and `get_message` for its reply; CLI `-i` input takes `questions` (see `examples/questions.json`); Python keyed clients validate them alike.
- Compatibility: clients before this release reject replies with Other answers (they read them as not matching the request), so update clients before sending `questions` or `other`.
- Forms: `minLength` and `maxLength` count code points, like every other length limit; question texts must be unique.

## 0.3.0-beta.5

- CLI: `send`, `ask` and `register` reach every capability through flags, merged onto `-i` input: `--body-file`, `--kind`, `--field ID[?]:TYPE[:LABEL[:CHOICES]]` (including `secret` and `secret-file`), `--action`, `--block TYPE=PATH` (code, diff, json, table from CSV, image), `--review`, and for `register` `--target`, `--webhook`, `--description`, `--type`. In `-i` input, image blocks may give a local `file`.
- CLI: `ask`, `send --wait` and `wait` take `--out [FIELD=]PATH` to write secret and file answers to new private files without printing them; `send --secret-file PATH` offers a secret. `request-secret`, `request-file`, `send-secret` and `upload` are removed.
- CLI: `integrate` and the bundled skills are removed. Skills are at https://herald.run/skills; register the MCP server with the client's own command, e.g. `claude mcp add herald -- npx -y @herald-run/mcp`.
- CLI: `account` shows the account holder and a separate `connection` line; `whoami` shows one `account` line.

## 0.3.0-beta.4

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
