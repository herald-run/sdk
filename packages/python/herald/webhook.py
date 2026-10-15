import hashlib
import hmac
import json
import re
import time


def verify_webhook(body, timestamp, signature, secret, tolerance=300):
    """Checks a task webhook's `Herald-Signature` over the exact body bytes; returns the event.
    Raises ValueError for stale, tampered or malformed deliveries."""
    raw = body if isinstance(body, bytes) else body.encode()
    if not isinstance(timestamp, str) or not isinstance(signature, str) or not re.fullmatch(r"\d+", timestamp) or not 0 <= tolerance < float("inf") or abs(time.time() - int(timestamp)) > tolerance or not re.fullmatch(r"[a-fA-F0-9]{64}", signature):
        raise ValueError("Invalid or stale webhook.")
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature.lower()):
        raise ValueError("Invalid webhook signature.")
    event = json.loads(raw)
    if not isinstance(event, dict) or event.get("type") != "task.created" or not isinstance(event.get("id"), str) or not isinstance(event.get("task"), dict) or event["task"].get("id") != event["id"]:
        raise ValueError("Invalid webhook event.")
    return event
