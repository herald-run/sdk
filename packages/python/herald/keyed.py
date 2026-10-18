"""End-to-end encryption for keyed tokens: seals what the client sends and opens what it reads."""
import json
import re
import time
import uuid
from datetime import date

from . import e2ee
from .e2ee import E2eeError
from .http import HeraldError

NO_ENTRY = "No recipient entry for these keys."
CONTENT = ("title", "body", "kind", "fields", "blocks", "actions", "requiresReview", "runId", "checkpointId", "group")
ENVELOPE_LIMIT = 20000
FIELD_TYPES = ("text", "textarea", "number", "select", "multiselect", "boolean", "date", "secret", "file")
FIELD_KEYS = ("id", "label", "type", "default", "nullable", "uniqueItems", "integer", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "required", "secret", "help", "placeholder", "options", "header", "other")
FIELD_ID = re.compile(r"[a-zA-Z][a-zA-Z0-9_-]{0,63}")
FILE_KEY = re.compile(r"[A-Za-z0-9_-]{43}")


def _invalid(message):
    raise HeraldError(message, 400)


def _uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value.lower()
    except ValueError:
        return False


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# What JavaScript's trim() removes; Python's strip() differs (keeps U+FEFF, drops \x1c-\x1f and U+0085).
JS_SPACE = "".join(map(chr, (*range(9, 14), 32, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF)))


def _trim(value):
    return value.strip(JS_SPACE)


def _fits(value, most):
    # Lengths are code points, as zod 4.6 counts them, not JavaScript's UTF-16 units.
    return isinstance(value, str) and len(value) <= most


def check_fields(fields):
    """Form fields with defaults filled, as the TypeScript SDK's `fieldsSchema` reads them."""
    if not isinstance(fields, list) or len(fields) > 30:
        _invalid("Use at most 30 fields.")
    out = []
    for field in fields:
        if not isinstance(field, dict) or not FIELD_ID.fullmatch(str(field.get("id"))) or field.get("type") not in FIELD_TYPES:
            _invalid("Fields need an id and a known type.")
        if not isinstance(field.get("label"), str) or not 0 < len(field["label"]) <= 120:
            _invalid("Field labels hold 1 to 120 characters.")
        if not _fits(field.get("help", ""), 300) or not _fits(field.get("placeholder", ""), 120):
            _invalid("Help holds up to 300 characters and placeholders 120.")
        options = field.get("options") or []
        if not isinstance(options, list) or len(options) > 50 or not all(
            isinstance(o, dict) and _fits(o.get("value"), 100) and _fits(o.get("label"), 120) and _fits(o.get("description", ""), 300) and _fits(o.get("preview", ""), 4000)
            for o in options
        ):
            _invalid("Use up to 50 options with a value and label; descriptions hold up to 300 characters and previews 4,000.")
        if not isinstance(field.get("other", False), bool):
            _invalid("Other is true or false.")
        if field["type"] in ("select", "multiselect") and not field.get("options"):
            _invalid(f"{field['label']} needs choices.")
        if field.get("secret") and (field["type"] != "file" or "default" in field):
            _invalid("Only file fields without defaults can be secret.")
        if field.get("other") and field["type"] not in ("select", "multiselect"):
            _invalid("Only choice fields can offer Other.")
        if "header" in field and not (isinstance(field["header"], str) and 0 < len(field["header"]) <= 24):
            _invalid("Field headers hold 1 to 24 characters.")
        out.append({"required": False, **{k: v for k, v in field.items() if k in FIELD_KEYS and v is not None}})
    if len({f["id"] for f in out}) != len(out):
        _invalid("Field IDs must be unique.")
    return out


def json_schema_fields(schema):
    """Form fields for a flat JSON Schema object (such as a Pydantic model's), like the TypeScript SDK."""
    if not isinstance(schema, dict) or schema.get("type") != "object" or schema.get("additionalProperties", False) is not False:
        _invalid("The form schema must be an object without additional properties.")
    props, required, defs = schema.get("properties") or {}, schema.get("required") or [], schema.get("$defs") or {}
    if any(k not in props for k in required):
        _invalid("Required fields must exist in properties.")

    def resolve(s):
        ref = s.get("$ref") if isinstance(s, dict) else None
        if ref is None:
            return s
        name = ref.removeprefix("#/$defs/")
        if name not in defs:
            _invalid("Only local $defs references are supported.")
        base = {k: v for k, v in defs[name].items() if k not in ("title", "description")}
        return {**base, **{k: v for k, v in s.items() if k != "$ref"}}

    fields = []
    for key, value in props.items():
        s, nullable = resolve(value), False
        if "anyOf" in s:
            variants = [resolve(v) for v in s["anyOf"]]
            scalar = [v for v in variants if v.get("type") != "null"]
            if len(variants) != 2 or len(scalar) != 1:
                _invalid("Only nullable scalar anyOf is supported.")
            s, nullable = {**{k: v for k, v in s.items() if k != "anyOf"}, **scalar[0]}, True
        kind, items, options = s.get("type"), resolve(s.get("items") or {}), None
        if isinstance(kind, list):
            if len(kind) != 2 or "null" not in kind:
                _invalid("Only nullable type unions are supported.")
            kind, nullable = next(t for t in kind if t != "null"), True
        if kind == "string" and "enum" in s:
            field_type, options = "select", s["enum"]
        elif kind == "string":
            field_type = {None: "text", "date": "date"}.get(s.get("format")) or _invalid("Unsupported string format.")
        elif kind in ("boolean", "number", "integer"):
            field_type = "boolean" if kind == "boolean" else "number"
        elif kind == "array" and s.get("x-herald-type") in ("file", "secret-file") and items.get("format") == "uuid":
            field_type = "file"
        elif kind == "array" and items.get("type") == "string" and isinstance(items.get("enum"), list):
            field_type, options = "multiselect", items["enum"]
        else:
            _invalid("Nested objects and this property type are not supported.")
        custom = s.get("x-herald-type")
        if custom in ("textarea", "secret") and field_type == "text":
            field_type = custom
        elif custom is not None and not (custom in ("file", "secret-file") and field_type == "file"):
            _invalid("Invalid x-herald-type.")
        names = {"title": "label", "description": "help"}
        extra = {names.get(k, k): s[k] for k in ("title", "description", "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems") if k in s}
        if custom == "secret-file":
            extra["secret"] = True
        fields.append({"id": key, "label": key, **extra, "type": field_type, "required": key in required, "nullable": nullable, "integer": kind == "integer", **({"options": [{"value": v, "label": v} for v in options]} if options else {})})
    return check_fields(fields)


def _text(value, most, name):
    if not isinstance(value, str) or not 0 < len(_trim(value)) <= most:
        _invalid(f"{name} hold 1 to {most} characters.")
    return _trim(value)


def question_fields(questions):
    """Required choice fields `q1`…`qN` with Other for agent-style questions, like the TypeScript SDK."""
    if not isinstance(questions, list) or not 0 < len(questions) <= 30:
        _invalid("Ask 1 to 30 questions.")
    fields = []
    for i, q in enumerate(questions, 1):
        q = q if isinstance(q, dict) else {}
        text, options, multi = _text(q.get("question"), 300, "Questions"), q.get("options"), q.get("multiSelect", False)
        if not isinstance(options, list) or not 0 < len(options) <= 50 or not all(isinstance(o, dict) for o in options) or not isinstance(multi, bool):
            _invalid("Questions have 1 to 50 options.")
        labels = [_text(o.get("label"), 100, "Option labels") for o in options]
        if len(set(labels)) != len(labels):
            _invalid("Option labels must be unique.")
        if any(not _fits(o.get(k, ""), n) for o in options for k, n in (("description", 300), ("preview", 4000))):
            _invalid("Option descriptions hold up to 300 characters and previews 4,000.")
        fields.append({
            "id": f"q{i}", "label": text if len(text) <= 120 else text[:119] + "…", **({"help": text} if len(text) > 120 else {}),
            **({"header": _text(q["header"], 24, "Headers")} if "header" in q else {}),
            "type": "multiselect" if multi else "select", "required": True, "other": True,
            "options": [{"value": label, "label": label, **{k: o[k] for k in ("description", "preview") if o.get(k)}} for label, o in zip(labels, options)],
        })
    if len({f.get("help", f["label"]) for f in fields}) != len(fields):
        _invalid("Each question must be unique.")
    return fields


def question_answers(questions, values):
    """Answers keyed by question text: chosen labels joined by ", ", or the Other text."""
    out = {}
    for i, q in enumerate(questions, 1):
        v = values.get(f"q{i}")
        out[_trim(q["question"])] = ", ".join(v) if isinstance(v, list) else "" if v is None else str(v)
    return out


def check_input(message):
    """A content message as the server would store it; keyed clients validate before sealing."""
    m = {k: v for k, v in message.items() if v is not None}
    if not isinstance(m.get("title"), str) or not 0 < len(m["title"]) <= 180:
        _invalid("Titles hold 1 to 180 characters.")
    if not isinstance(m.setdefault("body", ""), str) or len(m["body"]) > 50000:
        _invalid("Bodies hold at most 50,000 characters.")
    if m.setdefault("kind", "message") not in ("message", "form", "report", "files"):
        _invalid("Unknown message kind.")
    if "questions" in m:
        if m.get("fields") or "schema" in m:
            _invalid("Use questions, schema or fields, not several.")
        m["fields"] = question_fields(m.pop("questions"))
    if "schema" in m:
        if m.get("fields"):
            _invalid("Use schema or fields, not both.")
        m["fields"] = json_schema_fields(m.pop("schema"))
    m["fields"] = check_fields(m.get("fields", []))
    if "expiresAt" in m and "expiresIn" in m:
        _invalid("Use expiresAt or expiresIn, not both.")
    actions = m.get("actions")
    if actions is not None:
        if not isinstance(actions, list) or not 0 < len(actions) <= 8 or len({a.get("id") for a in actions}) != len(actions):
            _invalid("Use 1 to 8 actions with unique IDs.")
        for action in actions:
            if any(f["type"] in ("secret", "file") for f in m["fields"]) or validate_answers(m["fields"], action.get("values") or {}):
                _invalid("Actions must completely answer a form without secrets or files.")
    return m


def check_secret_offer(message):
    """A secret offer: a title and body only; the value goes to the receiver the account signs."""
    m = {k: v for k, v in message.items() if v is not None}
    if not isinstance(m.get("title"), str) or not 0 < len(m["title"]) <= 180:
        _invalid("Titles hold 1 to 180 characters.")
    if not isinstance(m.setdefault("body", ""), str) or len(m["body"]) > 50000:
        _invalid("Bodies hold at most 50,000 characters.")
    if any(m.get(k) for k in ("fields", "attachments", "blocks", "actions", "schema", "questions", "publicKey")):
        _invalid("Secret deliveries contain metadata only; use the encrypted delivery endpoint.")
    if "expiresAt" in m and "expiresIn" in m:
        _invalid("Use expiresAt or expiresIn, not both.")
    return m


def check_answers(values):
    ok = isinstance(values, dict) and all(
        isinstance(k, str) and len(k) <= 64 and (v is None or isinstance(v, bool) or _number(v) or (isinstance(v, str) and len(v) <= 16000) or (isinstance(v, list) and len(v) <= 50 and all(isinstance(x, str) and len(x) <= 100 for x in v)))
        for k, v in values.items()
    )
    return values if ok else e2ee._fail("Malformed answer.")


def validate_answers(fields, values, secret_ids=()):
    """Field errors for `values`, like the TypeScript SDK's `validateAnswers`."""
    errors, ids = {}, {f["id"] for f in fields}
    for key in [*values, *secret_ids]:
        if key not in ids:
            errors[key] = "Unknown field."
    for f in fields:
        v, kind, options = values.get(f["id"]), f["type"], [o["value"] for o in f.get("options") or []]
        if (kind == "secret" or f.get("secret")) and f["id"] in secret_ids:
            continue
        if f["id"] not in values or v is None:
            if (v is None and f["id"] in values and not f.get("nullable")) or (f["id"] not in values and f.get("required")):
                errors[f["id"]] = "Invalid value."
            continue
        bad = f.get("required") and v in ("", [])
        if _number(v):
            bad |= (f.get("integer") and v != int(v)) or v < f.get("minimum", v) or v > f.get("maximum", v)
            bad |= ("exclusiveMinimum" in f and v <= f["exclusiveMinimum"]) or ("exclusiveMaximum" in f and v >= f["exclusiveMaximum"])
        if isinstance(v, str):
            bad |= not f.get("minLength", 0) <= len(v) <= f.get("maxLength", len(v))
        if isinstance(v, list):
            bad |= not f.get("minItems", 0) <= len(v) <= f.get("maxItems", len(v)) or (bool(f.get("uniqueItems")) and len(set(v)) != len(v))
        if kind == "file":
            bad |= not isinstance(v, list) or len(v) > 10 or not all(_uuid(x) for x in v)
        elif kind == "number":
            bad |= not _number(v)
        elif kind == "boolean":
            bad |= not isinstance(v, bool)
        elif kind == "multiselect":
            # Other adds at most one non-blank free-text item.
            custom = [x for x in v if x not in options] if isinstance(v, list) else []
            bad |= not isinstance(v, list) or len(custom) > (1 if f.get("other") else 0) or any(not _trim(str(x)) for x in custom)
        elif kind == "select":
            bad |= v not in options and not (f.get("other") and isinstance(v, str) and _trim(v))
        elif kind in ("text", "textarea", "date", "secret"):
            bad |= not isinstance(v, str)
            if kind == "date" and not bad:
                try:
                    bad |= date.fromisoformat(v).isoformat() != v
                except ValueError:
                    bad = True
        if bad:
            errors[f["id"]] = "Invalid value."
    return errors


def session_values(session):
    out = {"prompt": session["prompt"], **({"attachments": session["attachments"]} if "attachments" in session else {})}
    out.update({"mode_" + k: v for k, v in (session.get("modes") or {}).items()})
    out.update({k: session[k] for k in ("model", "effort") if k in session})
    if session.get("command"):
        out["command"] = session["command"]["id"]
        out.update({"argument_" + k: v for k, v in (session["command"].get("arguments") or {}).items()})
    return out


def check_files(files):
    if files is None:
        return []
    ok = isinstance(files, list) and len(files) <= 30 and all(
        isinstance(f, dict) and _uuid(f.get("id")) and isinstance(f.get("name"), str) and isinstance(f.get("type"), str) and isinstance(f.get("size"), int) and FILE_KEY.fullmatch(str(f.get("key")))
        for f in files
    )
    return [{k: f[k] for k in ("id", "name", "type", "size", "key")} for f in files] if ok else e2ee._fail("Malformed attachments.")


def _omit(value, *keys):
    return {k: v for k, v in value.items() if v is not None and k not in keys}


def strip(m, flag):
    """Placeholder content for a record that could not be opened or verified."""
    out = {**_omit(m, "blocks", "actions", "session"), "e2ee": True, flag: True}
    if m.get("direction") != "outbound":
        out.update(title="Encrypted secret" if m.get("kind") == "secret" else "Encrypted message", body="", fields=[])
    if m.get("response"):
        out["response"] = {**_omit(m["response"], "actionId"), "values": {}}
    if m.get("input"):
        out["input"] = {**_omit(m["input"], "session"), "values": {}}
    for key in ("result", "execution"):
        if m.get(key):
            out[key] = _omit(m[key], "error")
    return out


class KeyedSession:
    def __init__(self, seed, fingerprint, directory, pin=None, on_pin=None):
        self.seed, self.fingerprint, self._directory = seed, fingerprint, directory
        # Team workspaces: the newest verified chain head and roster; `on_pin` stores newer ones.
        self.pin, self._on_pin = pin, on_pin
        # File keys learned from uploads and opened records, by file ID.
        self.files = {}
        # Task IDs -> the integration that runs them, so logs open only under its key.
        self._runners = {}
        # Record IDs -> their team, from opened records.
        self._teams = {}
        self._state, self._loaded = None, 0.0

    async def state(self, refresh=False):
        """The verified key directory, fetched once; `refresh` refetches at most every 10 s, `"force"` at once."""
        if self._state is None or refresh == "force" or (refresh and time.monotonic() - self._loaded > 10):
            self._loaded = time.monotonic()
            self._state = await self._load()
        return self._state

    async def _load_workspace(self, directory, me):
        ws = e2ee.verify_workspace(directory["workspace"], self.fingerprint, pin=self.pin)
        signers, kids, certs = {}, {}, {}
        for cert in directory.get("certificates") or []:
            try:
                checked = e2ee.verify_workspace_certificate(cert, ws)
            except (E2eeError, KeyError, TypeError):
                continue
            signers[checked["kid"]], kids[cert.get("integrationId")], certs[checked["kid"]] = checked["sign"], checked["kid"], checked
        # A certificate newer than the roster fails above, so a server cannot roll this token back.
        mine = certs.get(me.kid)
        if not mine or mine["sign"] != me.sign_pub:
            e2ee._fail("This token's key is not certified for the workspace.")
        if not self.pin or (self.pin["epoch"], self.pin["n"]) != (ws.pin["epoch"], ws.pin["n"]):
            self.pin = ws.pin
            if self._on_pin:
                self._on_pin(ws.pin)
        head = ws.head
        return {"directory": directory, "account": ws.workspace, "me": me, "identity": head["identity"], "identity_kid": head["signerKid"], "inbox": {"kid": head["boxKid"], "box": head["box"]}, "signers": signers, "kids": kids, "ws": ws, "certs": certs, "mine": mine}

    async def workspace(self):
        """The team workspace this token belongs to (id, epoch, the teams it may address), or None."""
        s = await self.state()
        ws = s.get("ws")
        if ws is None:
            return None
        team = lambda i: {"id": i, "slug": ws.teams[i]["slug"]}  # noqa: E731
        return {"id": ws.workspace, "fingerprint": self.fingerprint, "epoch": ws.epoch, "teams": [team(i) for i in s["mine"]["teams"]], "allTeams": [team(i) for i in ws.teams]}

    def _team(self, s, wanted=None):
        ws = s.get("ws")
        if ws is None:
            return None if wanted is None else e2ee._fail("Teams need a team workspace token.")
        if wanted is None:
            return s["mine"]["teams"][0]
        team = wanted if wanted in ws.teams else next((t["id"] for t in ws.teams.values() if t["slug"] == wanted), None)
        if team is None:
            e2ee._fail(f"Unknown team {wanted}.")
        if team not in s["mine"]["teams"]:
            e2ee._fail(f"This connection may not address team {wanted}.")
        return team

    async def team_of(self, record_id, record=None):
        """A record's team; `record` loads it when this session has not opened it."""
        s = await self.state()
        if s.get("ws") is None:
            return None
        if record_id not in self._teams and record is not None:
            await self.open_record(await record())
        return self._teams.get(record_id) or e2ee._fail("The record has no team.")

    async def _load(self):
        directory = await self._directory()
        me = e2ee.key_set(self.seed)
        if directory.get("workspace"):
            return await self._load_workspace(directory, me)
        if self.pin:
            e2ee._fail("This token belongs to a team workspace, but the server sent none.")
        if not directory.get("account"):
            e2ee._fail("End-to-end encryption is not set up for this account yet. Open Herald on a signed-in device first.")
        info = e2ee.verify_account(directory["account"], self.fingerprint)
        account = directory["account"]["statement"]["account"]
        signers, kids = {}, {}
        for cert in directory.get("certificates") or []:
            try:
                checked = e2ee.verify_certificate(cert, info.identity, account)
            except (E2eeError, KeyError, TypeError):
                continue
            signers[checked["kid"]] = checked["sign"]
            kids[cert.get("integrationId")] = checked["kid"]
        if signers.get(me.kid) != me.sign_pub:
            e2ee._fail("This token's key is not certified for the account.")
        return {"directory": directory, "account": account, "me": me, "identity": info.identity, "identity_kid": info.signer_kid, "inbox": {"kid": info.inbox_kid, "box": info.inbox}, "signers": signers, "kids": kids, "certs": {}}

    def _to(self, s, team=None):
        me = {"kid": s["me"].kid, "box": s["me"].box_pub}
        if s.get("ws") is None:
            return [s["inbox"], me]
        t = s["ws"].teams.get(team) if team else None
        return [{"kid": t["kid"], "box": t["box"]}, me] if t else e2ee._fail("Unknown team.")

    async def _open(self, env, expect, signer):
        """Opens `env` if exactly the kid `signer(state, env)` picks signed it; a new certificate triggers a refetch."""
        s = await self.state()
        if signer(s, env) != env.get("from"):
            s = await self.state(True)
        kid, ws, expect = signer(s, env), s.get("ws"), dict(expect)
        if ws is None:
            expect.pop("team", None)
            key = s["identity"] if kid == s["identity_kid"] else s["signers"].get(kid)
        elif not isinstance(expect.get("team"), str):
            return e2ee._fail("The record has no team.")
        else:
            key = e2ee.workspace_signer(ws, s["certs"], env.get("ctx"), kid) if kid and kid == env.get("from") else None
        return e2ee.open(env, recipients=[s["me"]], signers=lambda k: key if k == kid else None, expect={**expect, "account": s["account"]})

    @staticmethod
    def _identity(s, env=None):
        """The account identity, or in a team workspace the member named by `ctx.member`."""
        if s.get("ws") is None:
            return s["identity_kid"]
        member = s["ws"].members.get(((env or {}).get("ctx") or {}).get("member"))
        return member["kid"] if member else None

    @staticmethod
    def _integration(integration_id):
        return lambda s, env=None: s["kids"].get(integration_id) if integration_id else None

    def _learn(self, files):
        for f in files:
            self.files[f["id"]] = f

    async def _seal(self, payload, ctx, team=None):
        s = await self.state()
        return e2ee.seal(payload=payload, ctx={**ctx, "account": s["account"], **({"team": team} if team else {})}, signer=s["me"], to=self._to(s, team))

    async def seal_message(self, message, idempotency_key):
        """A sealed request body under a new record ID; secret offers seal their title and body."""
        message = dict(message)
        team = self._team(await self.state(), message.pop("team", None))
        body = await self._seal_message(message, idempotency_key, team)
        return {**body, "team": team} if team else body

    async def _seal_message(self, message, idempotency_key, team):
        record_id = str(uuid.uuid4())
        if message.get("kind") == "secret":
            m = check_secret_offer(message)
            payload = {"kind": "secret", "title": m["title"], "body": m["body"]}
            body = {"id": record_id, "kind": "secret", "sealed": await self._seal(payload, {"t": "message", "id": record_id}, team), "digest": e2ee.idempotency_digest(self.seed, payload, idempotency_key), "asks": False, "attachments": []}
            return {**body, **{k: m[k] for k in ("taskId", "replyTo", "expiresAt", "expiresIn") if k in m}}
        m = check_input(message)
        files = []
        for file in m.get("attachments") or []:
            known = {**self.files.get(file["id"], {}), **file}
            if not known.get("key"):
                e2ee._fail(f"Attachment {file['id']} was not uploaded by this keyed client.")
            files.append({k: known[k] for k in ("id", "name", "type", "size", "key")})
        payload = {"attachments": files, **{k: m[k] for k in CONTENT if k in m}}
        body = {"id": record_id, "kind": "message", "sealed": await self._seal(payload, {"t": "message", "id": record_id}, team), "digest": e2ee.idempotency_digest(self.seed, payload, idempotency_key), "asks": m["kind"] == "form" or bool(m["fields"]) or bool(m.get("actions")), "attachments": [{"id": f["id"]} for f in files]}
        return {**body, **{k: m[k] for k in ("taskId", "replyTo", "expiresAt", "expiresIn") if k in m}}

    async def open_record(self, m, task=False):
        """A record's sealed parts opened, with `e2ee: True`; failures are flagged `locked` or `unverified`.

        Content comes only from verified envelopes: an unsealed record and a sealed request with an
        unsealed answer are `unverified`."""
        if not isinstance(m, dict):
            return m
        ws = (await self.state()).get("ws")
        task = task or m.get("direction") == "outbound"
        if ws is not None and m.get("team"):
            self._teams[m["id"]] = m["team"]
        # `answeredBy` comes only from a verified answer.
        m = {k: v for k, v in m.items() if k != "answeredBy"}
        if m.get("response"):
            m["response"] = {k: v for k, v in m["response"].items() if k != "by"}
        response = m.get("response") or {}
        try:
            if task:
                if not (m.get("input") or {}).get("sealed"):
                    e2ee._fail("This task is not end-to-end encrypted.")
                if m.get("recipientId"):
                    self._runners[m["id"]] = m["recipientId"]
            elif not m.get("sealed"):
                e2ee._fail("This message is not end-to-end encrypted.")
            out = {**m, "e2ee": True}
            out = await (self._task(out, m["input"]["sealed"]) if task else self._content(out, m["sealed"]))
            if not task and response.get("sealed"):
                out = await self._response(out, m["sealed"], response["sealed"])
            elif not task and out.get("kind") != "secret" and (m.get("response") or m.get("status") == "answered"):
                e2ee._fail("A sealed request needs a sealed answer.")
            for key in ("result", "execution"):
                if not m.get(key):
                    continue
                env, error = m[key].get("sealed"), None
                if env:
                    error = (await self._open(env, {"t": "result", "task": m["id"], "team": m.get("team")}, self._integration(m.get("recipientId")))).get("error")
                    if error is not None and not isinstance(error, str):
                        e2ee._fail("Malformed task result.")
                out[key] = _omit({**_omit(m[key], "error"), "error": error})
            return out
        except E2eeError as error:
            return strip(m, "locked" if str(error) == NO_ENTRY else "unverified")

    async def _content(self, out, env):
        payload = await self._open(env, {"t": "message", "id": out.get("id"), "team": out.get("team")}, self._integration(out.get("senderId")))
        files = check_files(payload.pop("attachments", None))
        fields = {k: v for k, v in payload.items() if k != "v"}
        try:
            content = check_secret_offer(fields) if fields.get("kind") == "secret" else check_input(fields)
        except HeraldError:
            e2ee._fail("Malformed message content.")
        if (content.get("kind") == "secret") != (out.get("kind") == "secret"):
            e2ee._fail("The message kind does not match its record.")
        if content.get("kind") == "secret":
            content["fields"] = []
        self._learn(files)
        # Server copies of content fields are dropped; only the envelope's count.
        return {**_omit(out, *CONTENT), **{k: content[k] for k in CONTENT if k in content}, "attachments": files}

    async def _task(self, out, env):
        payload = await self._open(env, {"t": "task", "id": out.get("id"), "destination": out.get("destinationId"), "type": out.get("typeId"), "team": out.get("team")}, self._identity)
        values, session = check_answers(payload.get("values", {})), payload.get("session")
        if session is not None and not (isinstance(session, dict) and isinstance(session.get("prompt"), str)):
            e2ee._fail("Malformed task input.")
        files = check_files(payload.get("attachments"))
        self._learn(files)
        # Server copies of the input, session and answer are dropped; only the envelope's count.
        out = {**_omit(out, "session", "blocks", "actions"), "input": {**_omit(out["input"], "session"), "values": values, **({"session": session} if session else {})}, "attachments": files}
        if out.get("response"):
            out["response"] = {**_omit(out["response"], "actionId"), "values": {**values, **session_values(session)} if session else values}
        if session:
            out["session"] = _omit(session, "attachments")
        return out

    async def _response(self, out, request, env):
        expect = {"t": "response", "message": out["id"], "request": e2ee.envelope_digest(request), "team": out.get("team")}
        payload = await self._open(env, expect, self._identity)
        values, action, files = check_answers(payload.get("values")), payload.get("actionId"), check_files(payload.get("attachments"))
        actions, fields = out.get("actions") or [], out.get("fields") or []
        if action is not None:
            match = next((a for a in actions if a.get("id") == action), None)
            valid = isinstance(action, str) and match is not None and match.get("values") == values
        else:
            valid = not (actions and not fields) and not validate_answers(fields, values, out["response"].get("secretFields") or [])
        if not valid:
            e2ee._fail("The answer does not match the request.")
        self._learn(files)
        known = {f["id"] for f in out.get("attachments") or []}
        # Verified: the signer is this member of the request's team.
        by = env["ctx"]["member"] if (await self.state()).get("ws") is not None else None
        return {**out, **({"answeredBy": by} if by else {}), "response": _omit({**out["response"], "values": values, "actionId": action, "by": by}), "attachments": (out.get("attachments") or []) + [f for f in files if f["id"] not in known]}

    async def open_logs(self, task, logs, fetch):
        """A task's log lines opened; only the integration running the task may sign them. `fetch` loads the task record when this session has not opened it."""
        if not logs:
            return logs
        if task not in self._runners:
            await self.open_record(await fetch(), task=True)
        runner = self._runners.get(task)
        opened = []
        for log in logs:
            try:
                if not log.get("sealed"):
                    e2ee._fail("This log line is not end-to-end encrypted.")
                text = (await self._open(log["sealed"], {"t": "log", "task": task, "seq": log["sequence"], "team": self._teams.get(task)}, self._integration(runner))).get("text")
                opened.append({**log, "text": text, "e2ee": True} if isinstance(text, str) else e2ee._fail("Malformed log."))
            except E2eeError as error:
                opened.append({**log, "text": "", "e2ee": True, ("locked" if str(error) == NO_ENTRY else "unverified"): True})
        return opened

    async def seal_update(self, task, update, record=None):
        """Seals log text (at most 4,096 characters per line) and the error of a task update."""
        out = {k: v for k, v in update.items() if k not in ("logs", "error")}
        team = await self.team_of(task, record)

        async def seal(payload, ctx):
            env = await self._seal(payload, ctx, team)
            return env if len(json.dumps(env, separators=(",", ":"))) <= ENVELOPE_LIMIT else e2ee._fail("A sealed log line is too large.")
        if update.get("logs") is not None:
            out["logs"] = []
            for log in update["logs"]:
                if log.get("sealed"):
                    out["logs"].append({"sequence": log["sequence"], "stream": log["stream"], "text": "", "sealed": log["sealed"]})
                    continue
                if len(log["text"]) > 4096:
                    e2ee._fail("Log lines hold at most 4,096 characters.")
                out["logs"].append({"sequence": log["sequence"], "stream": log["stream"], "text": "", "sealed": await seal({"text": log["text"]}, {"t": "log", "task": task, "seq": log["sequence"]})})
        if update.get("error") is not None:
            out["errorSealed"] = await seal({"error": update["error"]}, {"t": "result", "task": task})
        return out

    async def open_secret(self, message, field, env, record=None):
        """A secret field's text, or a secret file field's attachments (their keys are learned)."""
        payload = await self._open(env, {"t": "secret", "message": message, "field": field, "team": await self.team_of(message, record)}, self._identity)
        if isinstance(payload.get("value"), str):
            return payload["value"]
        files = check_files(payload.get("files")) if payload.get("files") else e2ee._fail("Malformed secret.")
        self._learn(files)
        return files

    async def check_receiver(self, message, receiver, record=None):
        """Accepts a claimed receiver's one-time key only when the account identity signed it; in a team workspace, a member of the request's team."""
        if not receiver.get("claimId") or not receiver.get("publicKey"):
            return receiver
        if not receiver.get("sig"):
            e2ee._fail("The secret receiver is not signed by the account.")
        s = await self.state()
        if s.get("ws") is None:
            e2ee.verify_receiver(receiver["sig"], s["identity"], message=message, claim_id=receiver["claimId"], public_key=receiver["publicKey"])
            return receiver
        member = e2ee.team_member(s["ws"], receiver.get("member"), await self.team_of(message, record))
        e2ee.verify_receiver(receiver["sig"], member["identity"], message=message, claim_id=receiver["claimId"], public_key=receiver["publicKey"], member=receiver["member"])
        return receiver
