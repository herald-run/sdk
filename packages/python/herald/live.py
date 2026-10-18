import asyncio
import random
import time

STABLE = 30


def backoff(attempt, rand=random.random):
    """Reconnect delay in seconds: exponential from 1 s, capped at 30 s, with 50-100% jitter."""
    return min(30, 2 ** attempt) * (0.5 + rand() / 2)


class LiveSocket:
    """One socket shared by every waiter; each open, event or drop sets all subscribed events."""

    def __init__(self, connect, delay=backoff):
        self._connect = connect
        self._delay = delay
        self._events = set()
        self._task = None
        # Whether the socket is open, so events arrive without polling.
        self.connected = False

    def subscribe(self):
        event = asyncio.Event()
        self._events.add(event)
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())
        return event

    def unsubscribe(self, event):
        self._events.discard(event)
        if not self._events and self._task:
            self._task.cancel()
            self._task = None

    def _wake(self):
        for event in self._events:
            event.set()

    async def _run(self):
        attempt = 0
        while self._events:
            opened = None
            try:
                async with self._connect() as socket:
                    opened = time.monotonic()
                    self.connected = True
                    self._wake()
                    async for _ in socket:
                        self._wake()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Waiters still poll over HTTP, which reports authorization failures.
                pass
            finally:
                self.connected = False
            if opened is not None:
                # Waiters switch back to the faster poll while the socket is down.
                self._wake()
            if opened is not None and time.monotonic() - opened >= STABLE:
                attempt = 0
            await asyncio.sleep(self._delay(attempt))
            attempt += 1
