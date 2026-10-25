# herald-run

Python client for [Herald](https://herald.run), the human-in-the-loop inbox for agents: send messages, ask for approvals, run tasks, and move files and secrets. Python 3.11+. The import name is `herald`.

```sh
pip install --pre herald-run
```

## Authentication

Create a token in Herald under Settings → Connections, or run `npx @herald-run/cli login`. Pass it as `api_key`, or set `HERALD_API_KEY` (or `HERALD_TOKEN`). `HERALD_URL` selects another server. Never commit tokens.

Content is always end-to-end encrypted; tokens without a key are refused. Use a connection token (`hdr_<auth>.<seed>.<fingerprint>`, from `herald login` or Settings → Connections): the client encrypts and decrypts content itself and sends only `hdr_<auth>`; records it cannot decrypt or verify, including anything unsealed, come back with `locked` or `unverified` set and no content. Download files by passing the attachment (it carries the file key) to `download()`; `SyncHerald` behaves the same.

Team workspace tokens verify the workspace chain and roster. Store the newest verified pin with the token: pass `pin` and `on_pin`, or set `HERALD_PIN` (the pin as JSON). Without one, a fresh client trusts the newest chain and roster the server shows under the token's workspace safety code, so it cannot detect a rollback to before a removal it never saw.

## One-minute example

```python
import asyncio
from herald import Herald

async def main():
    async with Herald() as herald:
        await herald.send(title="Build passed", body="Preview is ready.")
        answer = await herald.ask_action(
            title="Deploy to production?",
            actions=[{"id": "approve", "label": "Approve", "values": {}}, {"id": "reject", "label": "Reject", "values": {}}],
            timeout=600,
        )
        print(answer.action_id)

asyncio.run(main())
```

Without asyncio, use `SyncHerald`, which has the same methods: `SyncHerald().send(title="Hi")`. Failures raise `HeraldError` with `status`, `code`, `message_id`, `retry_after` and `resets_at`. Methods are snake_case and return Pydantic models (`.wire()` gives the JSON). Documentation: [herald.run/docs/python](https://herald.run/docs/python/); API reference: [herald.run/docs/api](https://herald.run/docs/api/). MIT licensed.

Fleet: `fleet_worlds()`, `fleet_world("owner/repo")`, `fleet_report(world_id, [{"key": "ci-42", "state": {"name": "CI", "activity": "running"}}])`, `fleet_remove()` and `fleet_track()` report end-to-end encrypted unit states to Herald's Fleet view (needs `fleet:write`). States may carry `squad` and `parent` (an orchestrator's unit key).
