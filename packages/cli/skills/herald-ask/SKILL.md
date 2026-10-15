---
name: herald-ask
description: Ask the user for approval, a choice or structured input through Herald and wait for the answer. Use before risky or irreversible actions, or when a decision or missing detail blocks progress and the user may be away from the terminal.
---

# Ask for approval or input through Herald

Call the Herald MCP tool `ask` with a specific `title` and a Markdown `body` giving the context needed to decide (what, why, the risk). Pick one shape:

- `approval: true` for approve/reject; the result has `approved`.
- `choices: ["Option A", "Option B"]` for one of 2–8 options; the result has `choice`.
- `fields` (or a flat JSON Schema in `schema`) for a form; the result has `values`.
- Nothing extra for a free-text reply in `values.reply`.

`wait` bounds how long the call blocks (default 10m) and `deadline` when the request expires (default 1h). If the result is `status: "pending"`, call `wait` with its `id`; `expired` or `cancelled` means no answer: do not proceed with the gated action.

Without the MCP server: `npx @herald-run/cli ask --title "Deploy?" --timeout 10m` (exit code 0 answered, 3 expired, 4 cancelled), or `-i request.json` for forms.
