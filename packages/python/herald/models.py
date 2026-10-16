"""Herald API records. Attributes are snake_case; the wire format stays camelCase."""
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# Known values for typing; newer servers' values still parse as plain strings.
MessageStatus = Literal["pending", "answered", "delivered", "expired", "cancelled", "queued", "running", "completed", "failed"] | str
LogStream = Literal["stdout", "stderr"] | str


class Model(BaseModel):
    # Fields added by newer servers are kept, so records round-trip unchanged.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="allow")

    def wire(self):
        """The record as the API sent it."""
        return self.model_dump(mode="json", by_alias=True, exclude_unset=True)


class Attachment(Model):
    """`key` is the file key of an end-to-end encrypted file."""
    id: str
    name: str
    size: int
    type: str
    key: str | None = None


class Envelope(Model):
    key: str
    iv: str
    data: str


class Response(Model):
    values: dict[str, Any] = {}
    action_id: str | None = None
    secret_fields: list[str] = []
    created_at: str | None = None


class TaskLog(Model):
    sequence: int
    stream: LogStream
    text: str


class TaskInput(Model):
    destination_id: str
    type_id: str
    values: dict[str, Any] = {}
    session: dict[str, Any] | None = None


class TaskResult(Model):
    status: Literal["completed", "failed"]
    completed_at: str
    error: str | None = None


class TaskExecution(Model):
    attempt: int = 0
    acknowledged_at: str | None = None
    completed_at: str | None = None
    error: str | None = None
    logs: list[TaskLog] | None = None


class Message(Model):
    """A request, message or task; `direction: outbound` marks tasks."""
    id: str
    title: str
    status: MessageStatus
    kind: str = "message"
    direction: Literal["inbound", "outbound"] | None = None
    body: str = ""
    sender: str | None = None
    sender_id: str | None = None
    created_at: str | None = None
    revision: int | None = None
    fields: list[dict[str, Any]] = []
    attachments: list[Attachment] = []
    response: Response | None = None
    reply_to: str | None = None
    thread_id: str | None = None
    expires_at: str | None = None
    secret_delivery: str | None = None
    recipient_id: str | None = None
    input: TaskInput | None = None
    result: TaskResult | None = None
    execution: TaskExecution | None = None
    # End-to-end encryption: `sealed` content was opened (`e2ee`), or could not be decrypted
    # (`locked`) or verified (`unverified`), leaving placeholder content.
    sealed: dict[str, Any] | None = None
    e2ee: bool | None = Field(None, alias="e2ee")
    locked: bool | None = None
    unverified: bool | None = None


class Tombstone(Model):
    """A deleted message in the revision feed (`messages(after=n, tombstones=1)`)."""
    id: str
    revision: int
    deleted: Literal[True]


class ThreadPage(Model):
    messages: list[Message]
    next: int | None = None


class Destination(Model):
    id: str
    name: str
    integration_id: str | None = None
    key: str | None = None
    types: list[dict[str, Any]] = []
    signing_secret: str | None = None


class TaskClaim(Model):
    task: Message
    lease: str
    lease_expires_at: str | None = None


class Lease(Model):
    lease: str
    lease_expires_at: str


class SecretReceiver(Model):
    """`claim_id` and `public_key` once a device claims the offer; `received` after delivery."""
    claim_id: str | None = None
    public_key: dict[str, Any] | None = None
    received: bool | None = None
    sig: str | None = None


class Integration(Model):
    id: str
    name: str
    scopes: list[str]
    created_at: str | None = None


class CreatedIntegration(Model):
    token: str
    integration: Integration


class ActionAnswer(Model):
    action_id: str
    values: Any


class Ping(Model):
    ok: bool
    channel: str
    version: str


class TokenAccount(Model):
    email: str
    name: str | None = None


class TokenInfo(Model):
    """The calling integration token (`GET /token`)."""
    id: str
    name: str
    scopes: list[str]
    created_at: str | None = None
    last_used_at: str | None = None
    account: TokenAccount


class Account(Model):
    """Plan and usage of the token's account; newer fields are kept as extras."""
    id: str
    email: str
    name: str | None = None
    plan: str
    unmetered: bool | None = None
    used: int
    reserved: int | None = None
    credits: int | None = None
    storage: int
    devices: int | None = None
    usage_resets_at: str | None = None


class FileDownload(Model):
    name: str
    type: str
    data: bytes
