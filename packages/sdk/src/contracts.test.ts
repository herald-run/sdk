import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { generateSealedContracts } from '../fixtures/contracts-e2ee';
import {
  initialResults,
  materialize,
  sealedContracts,
  steps,
  substitute,
  type Exchange,
  type Reply,
  type SealedStep,
} from '../fixtures/contracts';
import { b64u, keyringKeys, open, openFile, parseToken, sealedSize } from './e2ee/index';
import { Herald, HeraldError } from './index';
afterEach(() => vi.restoreAllMocks());
type Args = { body: never; key?: string; id: string };
/** Every SDK step of the shared contract fixtures without content, as this client makes it. */
const calls: Record<string, (h: Herald, a: Args) => Promise<unknown>> = {
  register: (h, a) => h.register(a.body),
  destinations: (h) => h.destinations(),
  'update-destination': (h, a) => h.updateDestination(a.id, a.body),
  'get-missing': (h, a) => h.get(a.id),
  'rotate-secret': (h, a) => h.rotateDestinationSecret(a.id),
  account: (h) => h.account(),
  keys: (h) => h.keys(),
  'delete-destination': (h, a) => h.deleteDestination(a.id),
  integrations: (h) => h.integrations(),
};
/** Answers fetches with the step's replies, recording each request. */
function serve(replies: Reply[], auth = 'Bearer test-only') {
  const seen: (Exchange & { raw?: Uint8Array })[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = new URL(String(url));
    const headers = new Headers(init?.headers);
    const raw = init?.body
      ? new Uint8Array(await new Response(init.body).arrayBuffer())
      : undefined;
    const text = raw && new TextDecoder().decode(raw);
    expect(headers.get('Authorization')).toBe(auth);
    seen.push({
      method: init?.method || 'GET',
      path: target.pathname + target.search,
      headers: Object.fromEntries(headers),
      body: text && headers.get('Content-Type') === 'application/json' ? JSON.parse(text) : text,
      raw,
    });
    const reply = replies.shift()!;
    // A string or byte body is a file download's bytes.
    return typeof reply.body === 'string' || reply.body instanceof Uint8Array
      ? new Response(reply.body as BodyInit, { status: reply.status })
      : Response.json(reply.body, { status: reply.status });
  });
  return seen;
}

it('maps every SDK step of the contract fixtures', () => {
  expect(Object.keys(calls).sort()).toEqual(
    steps
      .filter((s) => !s.setup)
      .map((s) => s.name)
      .sort(),
  );
});
it('makes the fixture requests and returns the fixture responses', async () => {
  const herald = new Herald({ apiKey: 'test-only', url: 'https://herald.test' });
  const results = initialResults();
  const concrete = (step: string, reply: Reply) => ({
    status: reply.status,
    body: substitute(materialize(reply.body, step), results),
  });
  for (const step of steps) {
    const response = concrete(step.name, step.response);
    if (step.setup) {
      results[step.name] = response.body;
      continue;
    }
    const request = substitute(step.request, results);
    const replies = [response];
    if (step.upload) replies.push(concrete(step.name, step.upload.response));
    const seen = serve([...replies]);
    const args = {
      body: request.body as never,
      key: request.headers?.['Idempotency-Key'],
      id: decodeURIComponent(request.path.split('/')[4] || ''),
    };
    const call = calls[step.name](herald, args);
    if (response.status >= 400) {
      const error = await call.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, step.name).toBeInstanceOf(HeraldError);
      expect(error, step.name).toMatchObject({
        status: response.status,
        message: (response.body as { error: string }).error,
      });
    } else expect(await call, step.name).toEqual(response.body);
    const sent = seen.shift()!;
    expect(sent, step.name).toMatchObject({ method: request.method, path: request.path });
    expect(sent.body, step.name).toEqual(request.body);
    delete sent.raw;
    for (const [name, value] of Object.entries(request.headers || {}))
      expect(sent.headers?.[name.toLowerCase()], step.name).toBe(value);
    if (step.upload)
      expect(seen.shift(), step.name).toMatchObject({
        method: 'PUT',
        path: substitute(step.upload.path, { ...results, [step.name]: response.body }),
        body: step.upload.text,
      });
    expect(seen, step.name).toEqual([]);
    results[step.name] = response.body;
  }
});

const path = new URL('../fixtures/contracts.json', import.meta.url);
it('the keyed scenario is current', async () => {
  const generated = JSON.parse(JSON.stringify(await generateSealedContracts()));
  if (process.env.E2EE_CONTRACTS !== 'write') return expect(generated).toEqual(sealedContracts);
  const all = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...all, e2ee: generated }, null, 2) + '\n');
});
type Calls = Record<
  string,
  (h: Herald, s: SealedStep, id: string, key?: string) => Promise<unknown>
>;
/** The keyed client's call for every `e2ee` step. */
const sealedCalls: Calls = {
  keys: (h) => h.keys(),
  upload: (h) => h.upload('notes.txt', new TextEncoder().encode('hello'), 'text/plain'),
  send: (h, s, _, key) => h.send(s.input as never, key),
  get: (h, _, id) => h.get(id),
  thread: (h, _, id) => h.thread(id, 0),
  'get-tampered': (h, _, id) => h.get(id),
  'get-locked': (h, _, id) => h.get(id),
  'get-replayed': (h, _, id) => h.get(id),
  'get-unsealed-answer': (h, _, id) => h.get(id),
  'get-unsealed-from-keyed': (h, _, id) => h.get(id),
  'send-secret-form': (h, s, _, key) => h.send(s.input as never, key),
  'collect-secrets': (h, _, id) => h.revealSecrets(id),
  'claim-task': (h, s, id) => h.claimTask(id, s.request.body as never),
  'claim-unsealed-task': (h, s, id) => h.claimTask(id, s.request.body as never),
  'task-logs': (h, s, id, key) => h.updateTask(id, s.input as never, { idempotencyKey: key }),
  'read-task-logs': async (h, _, id) => ({ logs: await h.taskLogs(id) }),
  'complete-task': (h, s, id) => h.updateTask(id, s.input as never),
  download: async (h, s) =>
    new TextDecoder().decode(await (await h.download(s.input as never)).bytes()),
  'offer-secret': (h, s, _, key) => h.send(s.input as never, key),
  'secret-receiver': (h, _, id) => h.secretReceiver(id),
  'secret-receiver-forged': (h, _, id) => h.secretReceiver(id),
};
const like = (value: unknown): unknown =>
  value === '<string>'
    ? expect.any(String)
    : Array.isArray(value)
      ? value.map(like)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, like(v)]))
        : value;
const at = (value: unknown, dotted: string) =>
  dotted.split('.').reduce<any>((v, k) => v?.[k], value); // eslint-disable-line @typescript-eslint/no-explicit-any
it('replays the keyed scenario: seals requests, opens responses', async () => {
  const { token, keyring, steps: scenario } = sealedContracts;
  const herald = new Herald({ apiKey: token, url: 'https://herald.test' });
  const owner = await keyringKeys(keyring);
  const cert = (
    scenario[0].response.body as { certificates: { certificate: { kid: string; sign: string } }[] }
  ).certificates[0].certificate;
  expect(Object.keys(sealedCalls)).toEqual(scenario.map((s) => s.name));
  for (const step of scenario) {
    const reply = { ...step.response };
    if (step.bytes) reply.body = b64u.decode(reply.body as string);
    const seen = serve(
      [reply, ...(step.upload ? [step.upload.response] : [])],
      'Bearer hdr_test-only',
    );
    const id = decodeURIComponent(step.request.path.split('/')[4] || '');
    const call = sealedCalls[step.name](
      herald,
      step,
      id,
      step.request.headers?.['Idempotency-Key'],
    );
    if (step.error) await expect(call, step.name).rejects.toThrow(step.error);
    else expect(await call, step.name).toEqual(like(step.result));
    const sent = seen.shift()!;
    expect(sent, step.name).toMatchObject({ method: step.request.method, path: step.request.path });
    for (const [name, value] of Object.entries(step.request.headers || {}))
      expect(sent.headers?.[name.toLowerCase()], step.name).toBe(value);
    const body = structuredClone(sent.body) as Record<string, unknown>;
    const want = structuredClone(step.request.body) as Record<string, unknown>;
    for (const [dotted, payload] of Object.entries(step.sealed || {})) {
      const [mine, theirs] = [at(body, dotted), at(want, dotted)];
      const opened = await open(mine, {
        recipients: [owner.inbox[0]],
        signers: (kid) => (kid === cert.kid ? cert.sign : undefined),
        expect: { t: theirs.ctx.t, account: keyring.account },
      });
      expect(opened, step.name).toEqual(payload);
      expect({ ...mine.ctx, id: 0 }, step.name).toEqual({ ...theirs.ctx, id: 0 });
      // A sealed message's record ID is random per send and bound into its context.
      if (mine.ctx.t === 'message') {
        expect(body.id, step.name).toBe(mine.ctx.id);
        body.id = want.id;
      }
      expect(mine.to.map((r: { kid: string }) => r.kid)).toEqual(
        theirs.to.map((r: { kid: string }) => r.kid),
      );
      const parent = dotted.split('.');
      const leaf = parent.pop()!;
      const within = (value: unknown) => (parent.length ? at(value, parent.join('.')) : value);
      within(body)[leaf] = within(want)[leaf] = null;
    }
    expect(body, step.name).toEqual(want);
    if (step.upload) {
      const put = seen.shift()!;
      const result = (await call) as { key: string };
      expect(put, step.name).toMatchObject({ method: 'PUT', path: step.upload.path });
      expect(put.raw!.length).toBe(sealedSize(step.upload.plain.length));
      const plain = await new Response(openFile(result.key, put.raw!)).text();
      expect(plain).toBe(step.upload.plain);
    }
    expect(seen, step.name).toEqual([]);
    // Only `hdr_<auth>` ever leaves the process.
    expect(JSON.stringify(sent)).not.toContain(parseToken(token).seed);
  }
});
