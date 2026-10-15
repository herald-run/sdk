---
name: herald-share-secret
description: Send the user a secret (API key, password, generated credential) from a local file through encrypted Herald delivery, keeping it out of the conversation and message history. Use when the user needs a credential to paste elsewhere.
---

# Send a secret from a file

1. The secret must already be in a file (UTF-8, up to 16,000 bytes). Never put it in a command argument, chat message or ordinary Herald message.
2. Call the Herald MCP tool `send_secret` with the file `path` and a `title` naming what it is.
3. Without the MCP server, run: `npx @herald-run/cli send-secret --input PATH --title "Staging API key"`

The user receives it encrypted on their own device; only the status (`delivered`) comes back. Do not read the file into the conversation.
