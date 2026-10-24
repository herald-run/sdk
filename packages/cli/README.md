# @herald-run/cli

Command line client for [Herald](https://herald.run), the human-in-the-loop inbox for agents. Node.js 20 or later.

```sh
npx @herald-run/cli --help        # or: npm install -g @herald-run/cli
```

## Authentication

`herald login` opens the browser to approve this device and stores a scoped token in `~/.config/herald` (mode 0600); `--no-browser` prints the link only. `herald logout` revokes it. In CI, set `HERALD_API_KEY` (or `HERALD_TOKEN`) instead. `--profile NAME` (or `HERALD_PROFILE`) keeps separate logins; `--url` or `HERALD_URL` selects another server.

Content is always end-to-end encrypted; tokens without a key are refused. `herald login` stores a device key once you confirm that the account safety code it prints matches the approval page (outside a terminal, pass `--safety-code CODE`), and `herald whoami` shows the account safety code to compare with the one in Settings. Attachments download with `herald download <file-id> --message <message-id>`. Search runs locally over the newest five pages, since the server cannot read encrypted content. For a team workspace, log in with `herald login --workspace SLUG` and confirm the workspace safety code; `--team SLUG` picks the team on `send` and `ask`. A saved workspace login keeps its pin (the newest verified chain head and roster) current; with an env token, `--pin-file FILE` does the same, or `HERALD_PIN` supplies a read-only pin. Without a pin, a fresh token trusts the newest chain and roster the server shows under its workspace safety code.

## One-minute example

```sh
herald login
herald send --title 'Build passed' --body 'Preview is ready.' --file report.pdf
herald ask --title 'Deploy?' --timeout 10m && ./deploy.sh
herald messages --search deploy
```

## Forms, secrets and files

`send`, `ask` and `register` build everything from flags; `-i FILE` takes JSON input, and flags merge onto it. `herald help send` lists the grammar. In `-i` input, `questions` asks multiple-choice questions, each with an Other answer (see [`examples/questions.json`](../../examples/questions.json)).

```sh
herald ask --title 'Release?' --field 'env?:select:Environment:staging,prod' --action 'ship:Ship it'
herald send --title 'Review' --block code=src/app.ts --block table=results.csv --block image=shot.png --review
herald ask --field 'token:secret:GitHub token' --out ~/.config/gh/token
herald ask --field 'kubeconfig:secret-file:Staging kubeconfig' --out ~/.kube/staging
herald send --secret-file ./api-key --title 'Staging API key'
herald register --target laptop --type 'deploy:Deploy' --field 'env:select:Env:staging,prod'
```

Answers to secret and file fields go to new private files (`--out`, mode 0600) and are never printed; secret files reach this connection only and Herald deletes them 15 minutes after the answer.

## Claude Code and Codex

Install the agent skills from [herald.run/skills](https://herald.run/skills); they run this CLI, so `herald login` is the only setup. Other MCP clients can use the [`@herald-run/mcp`](https://www.npmjs.com/package/@herald-run/mcp) server.

## Fleet

Fleet shows each linked GitHub repo as a world of areas and your agents as units moving between them. Units are end-to-end encrypted; reporting needs the `fleet:write` scope (logins before it: run `herald login` again).

```sh
herald fleet init                  # write .herald/world.json from the top-level directories
herald fleet worlds                # list the account's worlds
herald fleet report --activity editing --file src/app.ts --task "Fix login"
herald fleet daemon                # keep running: coalesces local updates on one socket per world
```

`report` takes the repo from the `origin` remote, the branch from the checkout and the area from the files and the world file; branches `origin` has are tracked, so they show without a PR. `herald fleet hook` reads a Claude Code hook event on stdin, hands it to the daemon (or reports over HTTP at most every 15 s per session; a held idle or waiting state follows from a short background process), always exits 0 and prints nothing. In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "herald fleet hook" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "herald fleet hook" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "herald fleet hook" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "herald fleet hook" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "herald fleet hook" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "herald fleet hook" }] }]
  }
}
```

Reads, searches and listings show as reading, edits as editing, other tools and prompts as running; Stop is idle, Notification waiting, and SessionEnd removes the unit.

## Output

Output is human-readable; add `--json` for machine output. Exit codes: 0 success or answered, 1 error, 2 usage, 3 expired, 4 cancelled. `herald help <command>` shows every option; `herald completion bash|zsh|fish` prints shell completion. Documentation: [herald.run/docs/cli](https://herald.run/docs/cli/); API reference: [herald.run/docs/api](https://herald.run/docs/api/). MIT licensed.
