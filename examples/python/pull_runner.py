"""A minimal pull runner: registers a destination, then claims and completes its tasks."""
import asyncio
import json
import os
from pathlib import Path

from herald import Herald, HeraldError, TaskLog


async def main():
    async with Herald() as herald:
        spec = json.loads((Path(__file__).parent.parent / "destination.json").read_text())
        destination = await herald.register(**spec)
        runner_id = f"example-{os.getpid()}"
        print("Listening for tasks on", destination.key, "(Ctrl+C stops)")
        async for task in herald.watch():
            if task.direction != "outbound" or task.status != "queued" or task.input is None or task.input.destination_id != destination.id:
                continue
            try:
                claim = await herald.claim_task(task.id, runner_id=runner_id)
            except HeraldError:
                continue  # Another runner claimed it.
            prompt = task.input.values.get("prompt", "")
            await herald.update_task(task.id, lease=claim.lease, logs=[TaskLog(sequence=0, stream="stdout", text=f"Working on: {prompt}\n")])
            await herald.update_task(task.id, lease=claim.lease, status="completed")
            print("completed", task.id)


asyncio.run(main())
