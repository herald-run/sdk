import asyncio
import math
import random
import re
import time
from email.utils import parsedate_to_datetime


class HeraldError(Exception):
    def __init__(self, message, status, message_id=None, retry_after=None, code=None):
        super().__init__(message)
        self.status = status
        self.message_id = message_id
        # Seconds from the server's Retry-After header, when sent.
        self.retry_after = retry_after
        # Machine-readable code from the server's error body, e.g. "RATE_LIMITED".
        self.code = code


def retryable(error):
    return error.status == 429 or error.status >= 500


def parse_retry_after(value):
    """Retry-After as seconds: delta-seconds or an HTTP date."""
    if value is None or not value.strip():
        return None
    value = value.strip()
    if value.isdigit():
        return int(value)
    try:
        seconds = parsedate_to_datetime(value).timestamp() - time.time()
    except (TypeError, ValueError):
        return None
    return max(0, math.ceil(seconds))


def retry_delay(attempt):
    """Network and 5xx retry delay in seconds: 250 ms doubling, with 50-100% jitter."""
    return 0.25 * 2 ** attempt * (0.5 + random.random() / 2)


def error_text(data):
    error = data.get("error") if isinstance(data, dict) else None
    if isinstance(error, dict):
        return error.get("message")
    return error or (data.get("message") if isinstance(data, dict) else None)


def error_code(data):
    body = data if isinstance(data, dict) else {}
    code = body.get("error").get("code") if isinstance(body.get("error"), dict) else body.get("code")
    return code if isinstance(code, str) else None


def json_body(response):
    if not re.match(r"application/([\w.-]+\+)?json\b", response.headers.get("Content-Type", ""), re.I):
        return False, None
    try:
        return True, response.json()
    except ValueError:
        return True, None


def raise_error(response, fallback):
    """Raises the failed response's error message and code."""
    _, data = json_body(response)
    raise HeraldError(error_text(data) or fallback, response.status_code, retry_after=parse_retry_after(response.headers.get("Retry-After")), code=error_code(data))


def read_json(response, retry_after=None):
    """Checks status and content type before parsing, so proxies' HTML pages never reach JSON."""
    is_json, data = json_body(response)
    if response.is_error:
        raise HeraldError(error_text(data) or f"Herald request failed ({response.status_code}).", response.status_code, retry_after=retry_after, code=error_code(data))
    if response.status_code == 204:
        return None
    if not is_json or data is None:
        raise HeraldError("Herald returned a response that is not JSON.", response.status_code)
    return data


async def chunks(data, size=1 << 14):
    for start in range(0, len(data), size):
        yield bytes(data[start:start + size])


async def idle_body(source, idle_timeout):
    """Yields `source` in 16 KiB slices, so each socket write is small progress that resets
    httpx's write timeout; raises when the source stalls for `idle_timeout` seconds."""
    iterator = aiter(source)
    while True:
        try:
            chunk = await asyncio.wait_for(anext(iterator), idle_timeout)
        except StopAsyncIteration:
            return
        except TimeoutError as error:
            raise HeraldError(f"Upload stalled for {idle_timeout} s.", 408) from error
        for start in range(0, len(chunk), 1 << 14):
            yield bytes(chunk[start:start + (1 << 14)])
