import { afterEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { keyedClient } from '../fixtures/client';
import { E2eeError, Herald, HeraldError, verifyWebhook } from './index';
afterEach(() => vi.restoreAllMocks());
it('retries a lost creation response with the same key and body', async () => {
  const client = await keyedClient();
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new TypeError('Connection closed'))
    .mockResolvedValueOnce(Response.json({ id: 'message' }));
  expect(await client.send({ title: 'Hello' }, 'stable-key')).toMatchObject({ id: 'message' });
  expect(fetch.mock.calls).toHaveLength(2);
  expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body);
  expect(new Headers(fetch.mock.calls[1][1]?.headers).get('Idempotency-Key')).toBe('stable-key');
});
it('refuses tokens without a key and content calls without one', async () => {
  expect(() => new Herald({ apiKey: 'hdr_legacy' })).toThrow(E2eeError);
  const session = new Herald({ apiKey: 'session-token' });
  await expect(session.send({ title: 'Hello' })).rejects.toThrow('no end-to-end key');
  await expect(session.upload('a', new Uint8Array(1))).rejects.toThrow(E2eeError);
});
it('sets request deadlines separately from wait timeouts and returns typed answers', async () => {
  const client = await keyedClient();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'message' }));
  vi.spyOn(client, 'wait').mockResolvedValue({
    status: 'answered',
    response: { values: { approved: true } },
  } as never);
  expect(
    await client.ask<{ approved: boolean }>(
      {
        title: 'Deploy',
        timeout: '10m',
        schema: { type: 'object', properties: { approved: { type: 'boolean' } } },
      },
      { waitTimeout: 2 },
    ),
  ).toEqual({ approved: true });
  const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(sent.expiresIn).toBe(600);
  expect(client.wait).toHaveBeenCalledWith('message', { waitTimeout: 2 });
  await expect(
    client.ask({ title: 'Invalid', timeout: '5m', expiresAt: '2030-01-01T00:00:00Z' }),
  ).rejects.toThrow('Use timeout or expiresAt');
});
it('exposes resumable timeout IDs without cancelling the request', async () => {
  const client = new Herald();
  vi.spyOn(client, 'send').mockResolvedValue({ id: 'pending-id' } as never);
  vi.spyOn(client, 'wait').mockRejectedValue(new HeraldError('Wait timed out', 408, 'pending-id'));
  const cancel = vi.spyOn(client, 'cancel');
  await expect(client.ask({ title: 'Wait' })).rejects.toMatchObject({
    status: 408,
    messageId: 'pending-id',
  });
  expect(cancel).not.toHaveBeenCalled();
});
it('verifies exact webhook bytes and rejects stale or tampered deliveries', () => {
  const body = JSON.stringify({ id: 'one', type: 'task.created', task: { id: 'one' } }),
    timestamp = String(Math.floor(Date.now() / 1000)),
    secret = 'test-only';
  const signature = createHmac('sha256', secret)
    .update(timestamp + '.' + body)
    .digest('hex');
  expect(verifyWebhook(body, timestamp, signature, secret).id).toBe('one');
  expect(() => verifyWebhook(body + ' ', timestamp, signature, secret)).toThrow();
  expect(() => verifyWebhook(body, '1', signature, secret)).toThrow();
});

it('returns action identity with empty or typed values without changing ordinary ask', async () => {
  const client = await keyedClient();
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => Response.json({ id: 'action-request' }));
  const wait = vi.spyOn(client, 'wait').mockResolvedValue({
    id: 'action-request',
    status: 'answered',
    response: { actionId: 'resume', values: {} },
  } as never);
  const input = {
    title: 'Continue?',
    timeout: '5m',
    idempotencyKey: 'stable-action',
    actions: [{ id: 'resume', label: 'Resume run', values: {} }],
  };
  expect(await client.askAction(input, { waitTimeout: 2 })).toEqual({
    actionId: 'resume',
    values: {},
  });
  expect(wait).toHaveBeenCalledWith('action-request', { waitTimeout: 2 });
  const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(sent.sealed).toBeDefined();
  expect(sent.expiresIn).toBe(300);
  expect(new Headers(fetch.mock.calls[0][1]?.headers).get('Idempotency-Key')).toBe('stable-action');
  wait.mockResolvedValue({
    id: 'action-request',
    status: 'answered',
    response: { actionId: 'resume', values: { count: 2 } },
  } as never);
  const typedInput = {
    ...input,
    fields: [{ id: 'count', label: 'Count', type: 'number' as const, required: true }],
    actions: [{ ...input.actions[0], values: { count: 2 } }],
  };
  expect(await client.askAction<{ count: number }>(typedInput)).toEqual({
    actionId: 'resume',
    values: { count: 2 },
  });
  expect(await client.ask(typedInput)).toEqual({ count: 2 });
});
it('requires declared actions before sending and rejects missing or unknown response IDs', async () => {
  const client = new Herald();
  const send = vi.spyOn(client, 'send').mockResolvedValue({ id: 'action-request' } as never);
  const wait = vi.spyOn(client, 'wait');
  await expect(client.askAction({ title: 'Missing' } as never)).rejects.toThrow(
    'requires declared actions',
  );
  await expect(client.askAction({ title: 'Empty', actions: [] })).rejects.toThrow(
    'requires declared actions',
  );
  expect(send).not.toHaveBeenCalled();
  for (const actionId of [undefined, 'undeclared']) {
    wait.mockResolvedValue({
      id: 'action-request',
      status: 'answered',
      response: { actionId, values: {} },
    } as never);
    await expect(
      client.askAction({
        title: 'Continue?',
        actions: [{ id: 'resume', label: 'Resume run', values: {} }],
      }),
    ).rejects.toMatchObject({ status: 502, messageId: 'action-request' });
  }
});
it('preserves action request expiry and resumable wait failures', async () => {
  const client = new Herald();
  vi.spyOn(client, 'send').mockResolvedValue({ id: 'action-request' } as never);
  const wait = vi
    .spyOn(client, 'wait')
    .mockResolvedValue({ id: 'action-request', status: 'expired' } as never);
  const input = {
    title: 'Continue?',
    actions: [{ id: 'resume', label: 'Resume run', values: {} }],
  };
  await expect(client.askAction(input)).rejects.toMatchObject({
    status: 410,
    messageId: 'action-request',
  });
  wait.mockRejectedValue(new HeraldError('Wait timed out', 408, 'action-request'));
  await expect(client.askAction(input)).rejects.toMatchObject({
    status: 408,
    messageId: 'action-request',
  });
});

it('follows all thread pages and retains reply metadata', async () => {
  const client = await keyedClient('https://app.herald.run');
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      Response.json({ messages: [{ id: 'root', threadId: 'root', threadSequence: 1 }], next: 1 }),
    )
    .mockResolvedValueOnce(
      Response.json({
        messages: [{ id: 'reply', replyTo: 'root', threadId: 'root', threadSequence: 2 }],
      }),
    );
  const messages = [];
  for await (const message of client.threadMessages('reply')) messages.push(message);
  expect(messages.map((message) => message.id)).toEqual(['root', 'reply']);
  expect(messages[1].replyTo).toBe('root');
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    'https://app.herald.run/api/v1/messages/reply/thread?after=0',
    'https://app.herald.run/api/v1/messages/reply/thread?after=1',
  ]);
});
it('exposes Retry-After seconds when the wait exceeds maxRetryAfter', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({ error: 'Slow down.' }, { status: 429, headers: { 'Retry-After': '7' } }),
  );
  await expect(new Herald({ maxRetryAfter: 5 }).request('/messages')).rejects.toMatchObject({
    status: 429,
    retryAfter: 7,
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}, { status: 403 }));
  await expect(new Herald().request('/messages')).rejects.toMatchObject({ retryAfter: undefined });
});
