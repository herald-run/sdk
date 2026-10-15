"""Asks for an approval and exits 0 only when approved."""
import sys

from herald import SyncHerald

with SyncHerald() as herald:
    answer = herald.ask_action(
        title="Deploy to production?",
        body="The checks passed.",
        actions=[{"id": "approve", "label": "Approve", "values": {}}, {"id": "reject", "label": "Reject", "values": {}}],
        timeout=600,
    )
print(answer.action_id)
sys.exit(0 if answer.action_id == "approve" else 1)
