# @herald-run/mcp

[MCP](https://modelcontextprotocol.io) server for [Herald](https://herald.run), the human-in-the-loop inbox for agents. It lets Claude Code, Codex and other MCP clients message you, ask for approvals and input, move files and exchange secrets. Node.js 20 or later; stdio transport.

```sh
npx @herald-run/cli login                      # stores a token this server reuses
claude mcp add herald -- npx -y @herald-run/mcp
```

For Codex, add it to `~/.codex/config.toml`:

```toml
[mcp_servers.herald]
command = "npx"
args = ["-y", "@herald-run/mcp"]
```

Agent skills that use these tools are at [herald.run/skills](https://herald.run/skills).

## Authentication

`HERALD_API_KEY` (or `HERALD_TOKEN`) wins; otherwise the server reads the CLI's stored login for `HERALD_PROFILE` (default profile if unset). `HERALD_URL` selects another server. Content is always end-to-end encrypted; tokens without a key are refused. Records the connection cannot decrypt are reported as `locked`.

## Tools

| Tool             | Does                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `send`           | Markdown message, optional file paths to attach.                                                              |
| `ask`            | Approval, choice, multiple-choice `questions`, form (`fields` or JSON `schema`) or free-text question; waits. |
| `wait`, `cancel` | Keep waiting on, or cancel, a pending request.                                                                |
| `get_message`    | One message or task with its answer.                                                                          |
| `list_messages`  | Recent messages, with search and filters.                                                                     |
| `thread`         | A thread, oldest first.                                                                                       |
| `upload_file`    | Upload a file; `download_file` saves an attachment to a new file.                                             |
| `request_secret` | Encrypted form; writes the value to a new 0600 file and returns only the status.                              |
| `send_secret`    | Offers a secret from a file through encrypted delivery; returns only the status.                              |
| `request_file`   | Requests a file into a new 0600 file; returns only the status.                                                |

`ask` and `wait` block for `wait` (default 10m), then return `status: "pending"` with the message ID; the request stays open until its `deadline` (default 1h). Secret values and requested files never appear in tool results. Docs: https://herald.run/docs/agents/. MIT licensed.
