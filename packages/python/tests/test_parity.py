"""Python parity with the TypeScript SDK: crypto, webhooks, errors and the newer endpoints."""
import hashlib
import hmac
import json
import time
import unittest
from pathlib import Path

import httpx
from herald import Herald, HeraldError, SyncHerald, __version__, create_keys, seal, unseal, verify_webhook
from herald import keyed as forms
from fixtures import keyed

VECTORS = json.loads((Path(__file__).parents[2] / "sdk/fixtures/crypto-vectors.json").read_text())
QUESTIONS = json.loads((Path(__file__).parents[2] / "sdk/fixtures/questions.json").read_text())


def mock(handle, cls=Herald):
    return cls(api_key="test-only", url="https://herald.test", transport=httpx.MockTransport(handle))


class CryptoTests(unittest.TestCase):
    def test_opens_typescript_envelopes_and_round_trips(self):
        vector = VECTORS["typescript"]
        self.assertEqual(unseal(vector["envelope"], vector["privateKey"]), "test-only-value from TypeScript")
        public, private = create_keys()
        self.assertEqual((public["kty"], public["e"], public["alg"], public["key_ops"]), ("RSA", "AQAB", "RSA-OAEP-256", ["encrypt"]))
        self.assertTrue(300 <= len(public["n"]) <= 1400)
        self.assertNotIn("d", public)
        self.assertEqual(unseal(seal("test-only ✓", public), private), "test-only ✓")
        with self.assertRaises(Exception):
            unseal(seal("x", public), VECTORS["typescript"]["privateKey"])


class WebhookTests(unittest.TestCase):
    def test_verifies_exact_bytes_and_rejects_stale_or_tampered(self):
        body = json.dumps({"id": "one", "type": "task.created", "task": {"id": "one"}})
        stamp, secret = str(int(time.time())), "test-only"
        signature = hmac.new(secret.encode(), (stamp + "." + body).encode(), hashlib.sha256).hexdigest()
        self.assertEqual(verify_webhook(body, stamp, signature, secret)["id"], "one")
        self.assertEqual(verify_webhook(body.encode(), stamp, signature.upper(), secret)["id"], "one")
        for args in [(body + " ", stamp, signature), (body, "1", signature), (body, stamp, "0" * 64), (body, stamp, "zz")]:
            with self.assertRaises(ValueError):
                verify_webhook(*args, secret)
        # Signed but malformed events and non-string headers fail the same way.
        for raw in ["[1]", '{"id": "one", "type": "task.created", "task": "one"}']:
            signed = hmac.new(secret.encode(), (stamp + "." + raw).encode(), hashlib.sha256).hexdigest()
            with self.assertRaises(ValueError):
                verify_webhook(raw, stamp, signed, secret)
        with self.assertRaises(ValueError):
            verify_webhook(body, int(stamp), signature, secret)


class EndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_errors_carry_the_server_code(self):
        def handle(request):
            return httpx.Response(403, json={"error": "This staging inbox is private.", "code": "NOT_ADMITTED"})
        async with mock(handle) as client:
            with self.assertRaises(HeraldError) as caught:
                await client.account()
        self.assertEqual((caught.exception.status, caught.exception.code, str(caught.exception)), (403, "NOT_ADMITTED", "This staging inbox is private."))

    async def test_newer_endpoints_and_user_agent(self):
        seen = []

        def handle(request):
            seen.append((request.method, request.url.raw_path.decode(), json.loads(request.content) if request.content else None))
            self.assertEqual(request.headers["User-Agent"], "herald-python/" + __version__)
            route = (request.method, request.url.path)
            if route == ("GET", "/api/ping"):
                return httpx.Response(200, json={"ok": True, "channel": "staging", "version": "1"})
            if route == ("GET", "/api/v1/token"):
                return httpx.Response(200, json={"id": "t", "name": "CI", "scopes": ["messages:send"], "createdAt": "x", "lastUsedAt": None, "account": {"email": "a@example.com", "name": "A"}})
            if route == ("DELETE", "/api/v1/token"):
                return httpx.Response(204)
            return httpx.Response(404, json={"error": "Not found."})

        async with mock(handle) as client:
            self.assertEqual((await client.ping()).channel, "staging")
            self.assertEqual((await client.token()).account.email, "a@example.com")
            await client.revoke_token()
        self.assertIn(("DELETE", "/api/v1/token", None), seen)


class QuestionTests(unittest.TestCase):
    def test_questions_and_other_answers_match_typescript(self):
        fx, fields = QUESTIONS, QUESTIONS["fields"]
        self.assertEqual(forms.check_input({"title": "Q", "questions": fx["questions"]})["fields"], forms.check_fields(fields))
        self.assertEqual(forms.validate_answers(fields, fx["values"]), {})
        self.assertEqual(forms.question_answers(fx["questions"], fx["values"]), fx["answers"])
        for values in fx["rejected"]:
            self.assertEqual(len(forms.validate_answers(fields, values)), 1)
        long = forms.question_fields([{"question": "a" * 200, "options": [{"label": "x"}]}])[0]
        self.assertEqual((len(long["label"]), long["help"]), (120, "a" * 200))
        text = {"id": "a", "label": "A", "type": "text"}
        self.assertEqual(forms.check_fields([{**text, "header": "Short"}])[0]["header"], "Short")
        self.assertEqual(forms.validate_answers(forms.check_fields([{**text, "maxLength": 2}]), {"a": "\U0001f600" * 2}), {})
        choice = {**text, "type": "select", "options": [{"value": "x", "label": "X"}]}
        for bad in fx["invalid"]:
            with self.assertRaises(HeraldError):
                forms.question_fields(bad)
        for bad in [{"fields": [{**text, "other": True}]}, {"fields": [{**text, "header": "h" * 25}]}, {"questions": []},
                    {"fields": [{**choice, "other": "yes"}]}, {"fields": [{**text, "label": "\U0001f600" * 121}]},
                    {"fields": [{**choice, "options": [{"value": "x", "label": "X", "description": "d" * 301}]}]},
                    {"fields": [{**choice, "options": [{"value": "x", "label": "X", "preview": 1}]}]},
                    {"questions": [{"question": "Q", "options": [{"label": "x"}, {"label": "x"}]}]},
                    {"questions": fx["questions"], "fields": [text]}, {"questions": fx["questions"], "schema": {"type": "object"}}]:
            with self.assertRaises(HeraldError):
                forms.check_input({"title": "Q", **bad})
        with self.assertRaises(HeraldError):
            forms.check_secret_offer({"title": "Key", "questions": fx["questions"]})


class AnnotationTests(unittest.TestCase):
    def test_annotations_fields_and_answers(self):
        pdf = "00000000-0000-4000-8000-000000000001"
        field = {"id": "c", "label": "C", "type": "annotations", "attachmentId": pdf}
        fields = forms.check_fields([field])
        box = {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}
        note = {"page": 4, "anchor": "page", "text": "Check"}
        text = {**note, "anchor": "text", "quote": "Open", "boxes": [box, box]}
        image = {**note, "anchor": "image", "boxes": [box]}
        for values in [{}, {"c": []}, {"c": [note, text, image]}]:
            self.assertEqual(forms.validate_answers(fields, values), {})
            forms.check_answers(values)
        bads = [
            {**note, "page": 0}, {**note, "text": " "}, {**note, "extra": 1}, {**note, "anchor": "line"}, "text",
            {k: v for k, v in text.items() if k != "quote"}, {**text, "quote": " "}, {**note, "boxes": [box]},
            {**image, "boxes": [box, box]}, {**image, "quote": "Open"}, {**image, "boxes": [{**box, "x": 1.1}]},
            {**image, "boxes": [{**box, "x": -0.1}]}, {**text, "boxes": [box] * 101}, {**text, "boxes": []},
            {**image, "boxes": [{"x": 0.1, "y": 0.2, "w": 0.3}]},
        ]
        for bad in bads:
            self.assertEqual(list(forms.validate_answers(fields, {"c": [bad]})), ["c"])
        self.assertEqual(list(forms.validate_answers(forms.check_fields([{**field, "required": True}]), {"c": []})), ["c"])
        for bad in [{k: v for k, v in field.items() if k != "attachmentId"}, {**field, "default": []}, {**field, "type": "text"}, {**field, "attachmentId": "plan.pdf"}]:
            with self.assertRaises(HeraldError):
                forms.check_fields([bad])


class SyncTests(unittest.TestCase):
    def test_blocking_methods_and_iterators(self):
        def handle(request):
            if request.url.path.endswith("/thread"):
                after = request.url.params["after"]
                page = {"messages": [{"id": "a" + after, "title": "T", "status": "delivered"}]}
                return httpx.Response(200, json={**page, "next": 1} if after == "0" else page)
            return httpx.Response(201, json={"id": "m", "title": "Hi", "status": "delivered"})

        with keyed(handle, SyncHerald) as client:
            self.assertEqual(client.send(title="Hi").id, "m")
            self.assertEqual([m.id for m in client.thread_messages("m")], ["a0", "a1"])
            self.assertTrue(client.url.startswith("https://"))


if __name__ == "__main__":
    unittest.main()
