# herald-run

Python client for [Herald](https://herald.run), the human-in-the-loop inbox for agents: send messages, ask for approvals, run tasks, and move files and secrets. Python 3.11+. The import name is `herald`.

```sh
pip install --pre herald-run
```

## Authentication

Create a token in Herald under Settings → Connections, or run `npx @herald-run/cli login`. Pass it as `api_key`, or set `HERALD_API_KEY` (or `HERALD_TOKEN`). `HERALD_URL` selects another server. Never commit tokens.

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

Without asyncio, use `SyncHerald`, which has the same methods: `SyncHerald().send(title="Hi")`. Failures raise `HeraldError` with `status`, `code`, `message_id` and `retry_after`. Methods are snake_case and return Pydantic models (`.wire()` gives the JSON). Documentation: [herald.run/docs/python](https://herald.run/docs/python/); API reference: [herald.run/docs/api](https://herald.run/docs/api/). MIT licensed.
