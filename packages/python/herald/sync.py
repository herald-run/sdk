import asyncio
import inspect
import threading

from .client import Herald


class SyncHerald:
    """Blocking `Herald`: the same methods, run on a private event loop thread. Async generators
    (`thread_messages`, `watch`) become plain iterators. Call `close()` or use `with`."""

    def __init__(self, *args, **kwargs):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="herald", daemon=True)
        self._thread.start()

        async def make():
            return Herald(*args, **kwargs)

        self._client = self._run(make())

    def _run(self, coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop).result()

    def _iterate(self, generator):
        try:
            while True:
                try:
                    yield self._run(anext(generator))
                except StopAsyncIteration:
                    return
        finally:
            self._run(generator.aclose())

    def __getattr__(self, name):
        value = getattr(self._client, name)
        if inspect.iscoroutinefunction(value):
            return lambda *args, **kwargs: self._run(value(*args, **kwargs))
        if inspect.isasyncgenfunction(value):
            return lambda *args, **kwargs: self._iterate(value(*args, **kwargs))
        return value

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        if self._loop.is_closed():
            return
        self._run(self._client.close())
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join()
        self._loop.close()
