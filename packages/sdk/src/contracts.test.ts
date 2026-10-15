import { afterEach, expect, it, vi } from 'vitest';
import {
  initialResults,
  materialize,
  steps,
  substitute,
  type Exchange,
  type Reply,
} from '../fixtures/contracts';
import { Herald, HeraldError } from './index';
afterEach(() => vi.restoreAllMocks());
type Args = { body: never; key?: string; id: string };
/** Every SDK step of the shared contract fixtures, as this client makes it. */
const calls: Record<string, (h: Herald, a: Args) => Promise<unknown>> = {
  register: (h, a) => h.register(a.body),
  destinations: (h) => h.destinations(),
  'update-destination': (h, a) => h.updateDestination(a.id, a.body),
  upload: (h) => h.upload('notes.txt', new TextEncoder().encode('hello'), 'text/plain'),
  send: (h, a) => h.send(a.body, a.key),
  get: (h, a) => h.get(a.id),
  thread: (h, a) => h.thread(a.id, 0),
  messages: (h) => h.messages({ after: 0 }),
  'get-missing': (h, a) => h.get(a.id),
  'send-secret-form': (h, a) => h.send(a.body, a.key),
  'collect-secrets': (h, a) => h.collectSecrets(a.id),
  download: async (h, a) => new TextDecoder().decode(await (await h.download(a.id)).bytes()),
  'read-task-logs': async (h, a) => ({ logs: await h.taskLogs(a.id) }),
  'rotate-secret': (h, a) => h.rotateDestinationSecret(a.id),
  account: (h) => h.account(),
  'offer-secret': (h, a) => h.send(a.body, a.key),
  'secret-receiver': (h, a) => h.secretReceiver(a.id),
  'deliver-secret': (h, a) => h.deliverSecret(a.id, a.body),
  cancel: (h, a) => h.cancel(a.id),
  'claim-task': (h, a) => h.claimTask(a.id, a.body),
  'heartbeat-task': (h, a) => h.heartbeatTask(a.id, (a.body as { lease: string }).lease),
  'task-logs': (h, a) => h.updateTask(a.id, a.body, { idempotencyKey: a.key }),
  'complete-task': (h, a) => h.updateTask(a.id, a.body),
  'delete-destination': (h, a) => h.deleteDestination(a.id),
  'create-integration': (h, a) => h.createIntegration(a.body),
  integrations: (h) => h.integrations(),
  'delete-integration': (h, a) => h.deleteIntegration(a.id),
};
/** Answers fetches with the step's replies, recording each request. */
function serve(replies: Reply[]) {
  const seen: Exchange[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const target = new URL(String(url));
    const headers = new Headers(init?.headers);
    const text = init?.body ? await new Response(init.body).text() : undefined;
    expect(headers.get('Authorization')).toBe('Bearer test-only');
    seen.push({
      method: init?.method || 'GET',
      path: target.pathname + target.search,
      headers: Object.fromEntries(headers),
      body: text && headers.get('Content-Type') === 'application/json' ? JSON.parse(text) : text,
    });
    const reply = replies.shift()!;
    // A string body is a file download's bytes.
    return typeof reply.body === 'string'
      ? new Response(reply.body, { status: reply.status })
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
