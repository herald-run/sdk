"""Sends a file as a report: reserve, upload, then attach it to a message."""
import sys
from pathlib import Path

from herald import SyncHerald

if len(sys.argv) != 2:
    sys.exit("Usage: python file_report.py <file>")
path = Path(sys.argv[1])
with SyncHerald() as herald:
    file = herald.upload(path.name, path.read_bytes(), "application/pdf")
    message = herald.send(title="Nightly report", body="The report is attached.", attachments=[file])
print(message.id)
