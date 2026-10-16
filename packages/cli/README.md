# @herald-run/cli

Command line client for [Herald](https://herald.run), the human-in-the-loop inbox for agents. Node.js 20 or later.

```sh
npx @herald-run/cli --help        # or: npm install -g @herald-run/cli
```

## Authentication

`herald login` opens the browser to approve this device and stores a scoped token in `~/.config/herald` (mode 0600); `--no-browser` prints the link only. `herald logout` revokes it. In CI, set `HERALD_API_KEY` (or `HERALD_TOKEN`) instead. `--profile NAME` (or `HERALD_PROFILE`) keeps separate logins; `--url` or `HERALD_URL` selects another server.

On accounts with end-to-end encryption, `herald login` also stores a device key, and `herald whoami` shows the account safety code to compare with the one in Settings. Encrypted attachments download with `herald download <file-id> --message <message-id>`. Search runs locally over the newest five pages, since the server cannot read encrypted content.

## One-minute example

```sh
herald login
herald send --title 'Build passed' --body 'Preview is ready.' --file report.pdf
herald ask --title 'Deploy?' --timeout 10m && ./deploy.sh
herald messages --search deploy
```

## Claude Code and Codex

`herald integrate claude-code` (or `codex`) installs Herald skills (send a report, ask for approval, request or share a secret through a file) and registers the [`@herald-run/mcp`](https://www.npmjs.com/package/@herald-run/mcp) server. `--scope project` writes into the current directory instead of your user config; `--dry-run` previews the changes. Rerunning is safe.

## Output

Output is human-readable; add `--json` for machine output. Exit codes: 0 success or answered, 1 error, 2 usage, 3 expired, 4 cancelled. `herald help <command>` shows every option; `herald completion bash|zsh|fish` prints shell completion. Documentation: [herald.run/docs/cli](https://herald.run/docs/cli/); API reference: [herald.run/docs/api](https://herald.run/docs/api/). MIT licensed.
