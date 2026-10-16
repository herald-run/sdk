---
name: herald-get-file
description: Request a file (key file, certificate, kubeconfig, document) from the user through an end-to-end encrypted Herald form and save it to a private file without its content entering the conversation. Use when a needed file is only on the user's devices.
---

# Request a file into a private path

1. Choose a new file path outside the repository (for example `~/.config/<tool>/key.pem`); it must not exist.
2. Call the Herald MCP tool `request_file` with that `path`, a clear `label` such as "Staging kubeconfig" and a short `body` saying where to find it.
3. Without the MCP server, run: `npx @herald-run/cli request-file --out PATH --label "Staging kubeconfig"`

The file is written with mode 0600 and only the status is returned. Only this connection can decrypt it, and Herald deletes its copy 15 minutes after the answer. Never print, cat or log a sensitive file; pass it to tools by path.
