"""A keyed client for tests, on the contract fixtures' token and key directory."""
import inspect
import json
from pathlib import Path

import httpx
from herald import Herald

SCENARIO = json.loads((Path(__file__).parents[2] / "sdk/fixtures/contracts.json").read_text())["e2ee"]
STEP = {s["name"]: s for s in SCENARIO["steps"]}
DIRECTORY, TOKEN = STEP["keys"]["response"]["body"], SCENARIO["token"]


def keyed(handle, cls=Herald):
    """A client whose `GET /keys` answers with the fixtures' directory and other requests go to `handle`."""
    keys = httpx.Response(200, json=DIRECTORY)
    if inspect.iscoroutinefunction(handle):
        async def serve(request):
            return keys if request.url.path == "/api/v1/keys" else await handle(request)
    else:
        def serve(request):
            return keys if request.url.path == "/api/v1/keys" else handle(request)
    return cls(api_key=TOKEN, url="https://herald.test", transport=httpx.MockTransport(serve))
