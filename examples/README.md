# Examples

Each example reads the token from `HERALD_API_KEY` (or `HERALD_TOKEN`); `HERALD_URL` picks another server.

- CLI: `herald ask -i approval.json` or `herald ask -i questions.json`; `herald register -i destination.json`, then `herald listen --target laptop --config runner.json` (prints each task's JSON as its log).
- TypeScript (`ts/`, Node.js 22.18+ runs `.ts` directly): `npm install`, then `node approval.ts`, `node file-report.ts report.pdf`, `node pull-runner.ts`, `WEBHOOK_SECRET=… node webhook-receiver.ts`.
- Python (`python/`): `pip install --pre herald-run`, then `python approval.py`, `python file_report.py report.pdf`, `python pull_runner.py`.

The pull runners register the `laptop` destination from `destination.json` and complete each task with its prompt echoed to the logs. Dispatch a task from the Herald app to try them.
