---
name: herald-send-file
description: Send the user a file, report or status update through Herald so it reaches their phone and desktop. Use when the user asks to be sent a report, log, image or PDF, or to be notified when work finishes.
---

# Send a file or report through Herald

1. Write the file first (Markdown, PDF, image, log; up to 100 MB each, 10 per message).
2. Call the Herald MCP tool `send` with a short `title`, a Markdown `body` summarising what matters, and `files` set to the file paths.
3. Without the MCP server, run: `npx @herald-run/cli send --title "Report" --body "Summary" --file ./report.pdf`

Success returns a message ID: Herald accepted the message, not that the user has read it. Never put credentials in titles, bodies or files.
