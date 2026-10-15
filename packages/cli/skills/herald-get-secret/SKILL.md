---
name: herald-get-secret
description: Request an API key, token or password from the user through an end-to-end encrypted Herald form and save it to a private file without it ever entering the conversation. Use when a credential is missing.
---

# Request a secret into a file

1. Choose a new file path outside the repository (for example `~/.config/<tool>/token`); it must not exist.
2. Call the Herald MCP tool `request_secret` with that `path` and a clear `label` such as "GitHub token (repo scope)".
3. Without the MCP server, run: `npx @herald-run/cli request-secret --out PATH --label "GitHub token"`

The value is written with mode 0600 and only the status is returned. Never print, cat, echo or log the file; pass it to tools by path or load it into an environment variable inside the command that needs it.
