import { afterEach, expect, it, vi } from 'vitest';
import { sealedContracts } from '../fixtures/contracts';
import { ChatClient, type ChatMessage } from './chat';
import * as e2ee from './e2ee/index';
import { Herald, type KeyDirectory } from './index';
import { KeyedSession } from './keyed';
import type { EventSocket } from './socket';
afterEach(() => vi.restoreAllMocks());
const { token, keyring, steps } = sealedContracts;
const directory = steps.find((s) => s.name === 'keys')!.response.body as KeyDirectory;
const url = 'https://herald.test';
const runner = directory.certificates[0];
const human = 'h:' + keyring.account;
const agent = 'a:' + runner.integrationId;
const nonce = 'n'.repeat(22);
async function ownerKeys(): Promise<e2ee.ChatKeys> {
  const k = await e2ee.keyringKeys(keyring);
  const inbox = { kid: k.inboxKid, box: k.inbox[0].boxPub };
  return {
    account: keyring.account,
    principal: human,
    signer: { kid: k.signerKid, signPriv: k.identity.signPriv },
    openers: [{ kid: k.inboxKid, boxPub: k.inbox[0].boxPub, boxPriv: k.inbox[0].boxPriv }],
    recipient: (p) =>
      p === human
        ? inbox
        : p === agent
          ? { kid: runner.certificate.kid, box: runner.certificate.box }
          : undefined,
    verifier: (p) =>
      p === human
        ? { kid: k.signerKid, sign: k.identity.signPub }
        : p === agent
          ? { kid: runner.certificate.kid, sign: runner.certificate.sign }
          : undefined,
  };
}
async function makeRoom(over: Partial<e2ee.ChatRoom> = {}): Promise<e2ee.ChatRoom> {
  const owner = await ownerKeys();
  return {
    id: await e2ee.roomId([human, agent], nonce),
    kind: 'dm',
    nonce,
    head: 'head-1',
    headVersion: 1,
    lastSeq: 0,
    lastAt: 0,
    readSeq: 0,
    unread: 0,
    members: [
      { principal: human, type: 'human', kid: owner.recipient(human)!.kid, readSeq: 0 },
      { principal: agent, type: 'agent', kid: runner.certificate.kid, readSeq: 0 },
    ],
    ...over,
  };
}
const fromOwner = async (room: e2ee.ChatRoom, seq: number, text = 'hello') => {
  const owner = await ownerKeys();
  const id = crypto.randomUUID();
  const envelope = await e2ee.sealChat(owner, room, { id, text, seen: seq - 1 });
  return { seq, id, sender: human, sub: '', at: 1, kind: 'message', audience: 'all', envelope };
};
type Reply = unknown | (() => unknown);
function serve(routes: Record<string, Reply>) {
  const seen: { route: string; body?: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const u = new URL(String(input));
    const route = `${init?.method || 'GET'} ${u.pathname}`;
    seen.push({ route, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const key = Object.keys(routes).find((r) => route.startsWith(r));
    if (!key) return Response.json({ error: 'Not found.' }, { status: 404 });
    const value = routes[key];
    const out = typeof value === 'function' ? await (value as () => unknown)() : value;
    return out instanceof Response ? out : Response.json(out);
  });
  return seen;
}
const keysRoute = { 'GET /api/v1/keys': directory };
const client = () => new Herald({ apiKey: token, url }).chat;
it('seals a send to exactly the room and the owner can open it', async () => {
  const room = await makeRoom();
  const seen = serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}`]: room,
    [`POST /api/v1/chats/${room.id}/messages`]: { seq: 1, id: 'x' },
  });
  const out = await client().send(room.id, 'secret words', { sub: 'plan' });
  expect(out.seq).toBe(1);
  const post = seen.find((s) => s.route.startsWith('POST'))!;
  expect(JSON.stringify(post)).not.toContain('secret words');
  const env = post.body!.envelope as e2ee.SealedEnvelope;
  expect(env.to.map((r) => r.kid).sort()).toEqual(room.members.map((m) => m.kid).sort());
  expect(env.ctx).toMatchObject({ t: 'chat', room: room.id, head: 'head-1', sub: 'plan' });
  const record = {
    seq: 1,
    id: post.body!.id as string,
    sender: agent,
    sub: 'plan',
    at: 1,
    kind: 'message' as const,
    audience: 'all' as const,
    envelope: env,
  };
  const payload = await e2ee.openChat(await ownerKeys(), room.id, record);
  expect(payload).toMatchObject({ kind: 'message', text: 'secret words', seen: 0 });
});
it('refuses a room the server tampered with, before sealing', async () => {
  const room = await makeRoom();
  const third = { principal: 'a:other', type: 'agent' as const, kid: 'k'.repeat(22), readSeq: 0 };
  const bad = [
    { ...room, nonce: 'm'.repeat(22) },
    { ...room, members: [...room.members, third] },
    { ...room, members: [room.members[0], third] },
    { ...room, members: [{ ...room.members[0], kid: 'k'.repeat(22) }, room.members[1]] },
  ];
  for (const view of bad) {
    const seen = serve({ ...keysRoute, [`GET /api/v1/chats/${room.id}`]: view });
    await expect(client().send(room.id, 'x')).rejects.toThrow(e2ee.E2eeError);
    expect(seen.some((s) => s.route.startsWith('POST'))).toBe(false);
    vi.restoreAllMocks();
  }
});
it('reseals once after ROOM_STALE and gives up after a second', async () => {
  const room = await makeRoom();
  const stale = () => Response.json({ error: 'stale', code: 'ROOM_STALE' }, { status: 409 });
  let posts = 0;
  const seen = serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}`]: () => ({ ...room, headVersion: 1 + posts }),
    [`POST /api/v1/chats/${room.id}/messages`]: () =>
      ++posts === 1 ? stale() : { seq: 2, id: 'x' },
  });
  await client().send(room.id, 'again');
  const sends = seen.filter((s) => s.route.startsWith('POST'));
  expect(sends.map((s) => s.body!.headVersion)).toEqual([1, 2]);
  expect(sends[0].body!.id).toBe(sends[1].body!.id);
  vi.restoreAllMocks();
  serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}`]: room,
    [`POST /api/v1/chats/${room.id}/messages`]: stale,
  });
  await expect(client().send(room.id, 'again')).rejects.toThrow('stale');
});
it('opens messages and locks forged ones', async () => {
  const room = await makeRoom();
  const good = await fromOwner(room, 1, 'hi');
  const replayed = { ...(await fromOwner(room, 2)), id: crypto.randomUUID() };
  const spoofed = { ...(await fromOwner(room, 3)), sender: agent };
  const hiddenKind = { ...(await fromOwner(room, 4)), kind: 'title' };
  serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}/messages`]: {
      messages: [good, replayed, spoofed, hiddenKind],
      through_seq: 4,
      hasMore: false,
    },
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  const { messages } = await client().read(room.id);
  expect(messages.map((m) => [m.text, !!m.locked])).toEqual([
    ['hi', false],
    ['', true],
    ['', true],
    ['', true],
  ]);
  expect(JSON.stringify(messages)).not.toContain('envelope');
});
it('wait with an explicit cursor still reads past it', async () => {
  const room = await makeRoom();
  const m1 = await fromOwner(room, 1, 'one');
  const seen = serve({
    ...keysRoute,
    [`POST /api/v1/chats/${room.id}/ack`]: null,
    [`GET /api/v1/chats/${room.id}/messages`]: { messages: [m1], through_seq: 1, hasMore: false },
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  const got = await client().wait(room.id, { after: 0, timeout: 1, for: 'lead' });
  expect(got.map((m) => m.text)).toEqual(['one']);
  expect(seen.some((s) => s.route.endsWith('/lease'))).toBe(false);
  // The ack settles the agent's wake.
  expect(seen.find((s) => s.route.endsWith('/ack'))?.body).toEqual({ seq: 1, subagent: 'lead' });
});
it('wait returns pending messages from others and acks them', async () => {
  const room = await makeRoom({ readSeq: 1 });
  const m2 = await fromOwner(room, 2, 'two');
  const seen = serve({
    ...keysRoute,
    [`POST /api/v1/chats/${room.id}/lease`]: {
      wake: {
        room: room.id,
        first: 2,
        seq: 2,
        reason: 'message',
        context: 'message',
        contextFrom: 2,
      },
    },
    [`POST /api/v1/chats/${room.id}/ack`]: null,
    [`GET /api/v1/chats/${room.id}/messages`]: {
      messages: [m2],
      through_seq: 2,
      hasMore: false,
    },
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  const got = await client().wait(room.id, { timeout: 1 });
  expect(got.map((m) => m.text)).toEqual(['two']);
  expect(seen.find((s) => s.route.endsWith('/ack'))!.body).toEqual({ seq: 2, subagent: '' });
  expect(seen.some((s) => s.route.endsWith('/read'))).toBe(false);
});
class FakeSocket implements EventSocket {
  handlers = new Map<string, (d?: unknown) => void>();
  on(e: string, f: (d?: unknown) => void) {
    this.handlers.set(e, f);
    return this;
  }
  send() {}
  close() {
    this.handlers.get('close')?.();
  }
  emit(frame: unknown) {
    this.handlers.get('message')?.(JSON.stringify(frame));
  }
}
const flush = () => new Promise((r) => setTimeout(r, 20));
it('retries a socket that has not opened by the next keepalive', async () => {
  vi.useFakeTimers();
  const opened: FakeSocket[] = [];
  const unused = () => Promise.reject(new Error('unused'));
  const chat = new ChatClient(
    unused,
    unused as never,
    () => {
      opened.push(new FakeSocket());
      return opened.at(-1)!;
    },
    unused,
  );
  const stop = new AbortController();
  const done = chat.wakes(() => {}, { signal: stop.signal });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(opened).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(opened).toHaveLength(2);
  stop.abort();
  await done;
  vi.useRealTimers();
});
it('wakes passes stop requests to onStop', async () => {
  const socket = new FakeSocket();
  const [a, b] = ['a'.repeat(43), 'b'.repeat(43)];
  const unused = () => Promise.reject(new Error('unused'));
  const chat = new ChatClient(unused, unused as never, () => socket, unused);
  const stop = new AbortController();
  const got: unknown[] = [];
  const done = chat.wakes(() => {}, {
    signal: stop.signal,
    rooms: [a],
    onStop: (s) => void got.push(s),
  });
  socket.emit({ type: 'stop', room: a, subagent: 'lead', by: 'h:ann' });
  socket.emit({ type: 'stop', room: b, subagent: 'lead', by: 'h:ann' });
  socket.emit({ type: 'stop', room: a, by: 'h:ann' });
  expect(got).toEqual([{ room: a, subagent: 'lead', by: 'h:ann' }]);
  stop.abort();
  socket.close();
  await done;
});
it('wakes survives a throwing onStop', async () => {
  const socket = new FakeSocket();
  const a = 'a'.repeat(43);
  const unused = () => Promise.reject(new Error('unused'));
  const chat = new ChatClient(unused, unused as never, () => socket, unused);
  const stop = new AbortController();
  const errors: unknown[] = [];
  const done = chat.wakes(() => {}, {
    signal: stop.signal,
    onStop: () => {
      throw new Error('boom');
    },
    onError: (e) => void errors.push(e),
  });
  socket.emit({ type: 'stop', room: a, subagent: 'lead', by: 'h:ann' });
  expect(errors).toHaveLength(1);
  stop.abort();
  socket.close();
  await done;
});
it('wakes reports a rejected async onStop', async () => {
  const socket = new FakeSocket();
  const a = 'a'.repeat(43);
  const unused = () => Promise.reject(new Error('unused'));
  const chat = new ChatClient(unused, unused as never, () => socket, unused);
  const stop = new AbortController();
  const errors: unknown[] = [];
  const done = chat.wakes(() => {}, {
    signal: stop.signal,
    onStop: async () => {
      throw new Error('boom');
    },
    onError: (e, room) => void errors.push([e, room]),
  });
  socket.emit({ type: 'stop', room: a, subagent: 'lead', by: 'h:ann' });
  await new Promise((r) => setTimeout(r, 0));
  expect(errors).toHaveLength(1);
  expect(errors[0]).toEqual([new Error('boom'), a]);
  stop.abort();
  socket.close();
  await done;
});
it('wakes passes archive, restore and delete frames to onRoom', async () => {
  const socket = new FakeSocket();
  const [a, b] = ['a'.repeat(43), 'b'.repeat(43)];
  const unused = () => Promise.reject(new Error('unused'));
  const chat = new ChatClient(unused, unused as never, () => socket, unused);
  const stop = new AbortController();
  const got: unknown[] = [];
  const done = chat.wakes(() => {}, {
    signal: stop.signal,
    rooms: [a],
    onRoom: (e) => void got.push(e),
  });
  socket.emit({ type: 'room', room: a, headVersion: 2, archivedAt: 1700 });
  socket.emit({ type: 'room', room: a, headVersion: 2, archivedAt: null });
  socket.emit({ type: 'room', room: a, headVersion: 3 });
  socket.emit({ type: 'room', room: b, archivedAt: 5 });
  socket.emit({ type: 'deleted', room: a });
  socket.emit({ type: 'deleted', room: b });
  expect(got).toEqual([
    { room: a, archivedAt: 1700 },
    { room: a, archivedAt: null },
    { room: a, deleted: true },
  ]);
  stop.abort();
  socket.close();
  await done;
});
it('wakes reports a throwing or rejecting onRoom to onError', async () => {
  const socket = new FakeSocket();
  const a = 'a'.repeat(43);
  const unused = () => Promise.reject(new Error('unused'));
  const chat = new ChatClient(unused, unused as never, () => socket, unused);
  const stop = new AbortController();
  const errors: unknown[] = [];
  let n = 0;
  const done = chat.wakes(() => {}, {
    signal: stop.signal,
    onRoom: async () => {
      if (n++) throw new Error('late');
      throw new Error('boom');
    },
    onError: (e, room) => void errors.push([e, room]),
  });
  socket.emit({ type: 'deleted', room: a });
  socket.emit({ type: 'room', room: a, archivedAt: null });
  await new Promise((r) => setTimeout(r, 0));
  expect(errors).toEqual([
    [new Error('boom'), a],
    [new Error('late'), a],
  ]);
  stop.abort();
  socket.close();
  await done;
});
it('listen delivers each message once, catches up on wake and gaps, and acks', async () => {
  const room = await makeRoom();
  const m1 = await fromOwner(room, 1, 'one');
  const m2 = await fromOwner(room, 2, 'two');
  const m4 = await fromOwner(room, 4, 'four');
  const h = new Herald({ apiKey: token, url });
  const session = new KeyedSession(
    e2ee.parseToken(token).seed!,
    e2ee.parseToken(token).fingerprint!,
    () => h.request('/keys'),
  );
  let after = 0;
  const seen = serve({
    ...keysRoute,
    [`POST /api/v1/chats/${room.id}/ack`]: null,
    [`GET /api/v1/chats/${room.id}/messages`]: () => {
      const page = after === 0 ? [m1] : [m4];
      after++;
      return { messages: page, through_seq: page[0].seq, hasMore: false };
    },
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  const socket = new FakeSocket();
  const chat = new ChatClient(
    (p, b, o) => h.request(p, b, o),
    () => session,
    () => socket,
    () => Promise.reject(new Error('unused')),
  );
  const got: ChatMessage[] = [];
  const stop = new AbortController();
  const done = chat.listen((m) => void got.push(m), { signal: stop.signal });
  await flush();
  // Wait on results, not time: decryption and requests run slower under load.
  const acks = () => seen.filter((s) => s.route.endsWith('/ack')).map((s) => s.body!.seq);
  socket.emit({ type: 'wake', room: room.id, seq: 1 });
  await vi.waitFor(() => expect(acks()).toEqual([1]));
  socket.emit({ type: 'message', room: room.id, prev: 1, ...m2 });
  await vi.waitFor(() => expect(acks()).toEqual([1, 2]));
  // A duplicate is ignored; seq 4 with prev 3 is a gap and is read back.
  socket.emit({ type: 'message', room: room.id, prev: 1, ...m2 });
  socket.emit({ type: 'message', room: room.id, prev: 3, seq: 4, hint: true });
  await vi.waitFor(() => expect(acks()).toEqual([1, 2, 4]));
  await flush();
  stop.abort();
  await done;
  expect(got.map((m) => m.text)).toEqual(['one', 'two', 'four']);
  expect(acks()).toEqual([1, 2, 4]);
});
async function groupOf(over: Partial<e2ee.ChatRoom> = {}) {
  const owner = await ownerKeys();
  const id = await e2ee.groupRoomId(human, nonce);
  const signed = await e2ee.signChatHead(owner, {
    room: id,
    version: 1,
    prev: '',
    owners: [human],
    members: [human, agent],
  });
  const dm = await makeRoom();
  const room: e2ee.ChatRoom = {
    ...dm,
    id,
    kind: 'group',
    head: await e2ee.headHash(signed.head),
    chain: [signed],
    ...over,
  };
  return { room, signed, owner };
}
it('wakes runs once per lease, then acks and re-leases the rest', async () => {
  const { room } = await groupOf({ lastSeq: 2 });
  const first = await fromOwner(room, 1, 'one');
  const h = new Herald({ apiKey: token, url });
  const parsed = e2ee.parseToken(token);
  const session = new KeyedSession(parsed.seed!, parsed.fingerprint!, () => h.request('/keys'));
  let leases = 0;
  const seen = serve({
    ...keysRoute,
    'GET /api/v1/chats/wakes': { wakes: [{ room: room.id }] },
    [`POST /api/v1/chats/${room.id}/lease`]: () => ({
      wake:
        leases++ === 0
          ? {
              room: room.id,
              first: 1,
              seq: 1,
              reason: 'mention',
              context: 'message',
              contextFrom: 1,
            }
          : null,
    }),
    [`POST /api/v1/chats/${room.id}/ack`]: null,
    [`GET /api/v1/chats/${room.id}/messages`]: {
      messages: [first],
      through_seq: 1,
      hasMore: false,
    },
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  const socket = new FakeSocket();
  const chat = new ChatClient(
    (p, b, o) => h.request(p, b, o),
    () => session,
    () => socket,
    () => Promise.reject(new Error('unused')),
  );
  const got: string[] = [];
  const stop = new AbortController();
  const done = chat.wakes((w) => void got.push(w.reason + ':' + w.messages[0].text), {
    signal: stop.signal,
  });
  await flush();
  socket.handlers.get('open')?.();
  await flush();
  stop.abort();
  await done;
  expect(got).toEqual(['mention:one']);
  expect(seen.filter((s) => s.route.endsWith('/ack')).map((s) => s.body!.seq)).toEqual([1]);
});
it('refuses a group whose recent messages name a head missing from its chain', async () => {
  const { room, signed, owner } = await groupOf();
  const v2 = await e2ee.signChatHead(owner, {
    ...signed.head,
    version: 2,
    prev: room.head,
  });
  const newest = {
    ...room,
    head: await e2ee.headHash(v2.head),
    headVersion: 2,
    chain: [signed, v2],
  };
  const message = await fromOwner(newest, 1, 'on v2');
  const page = { messages: [message], through_seq: 1, hasMore: false };
  serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}/messages`]: page,
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  await expect(client().open(room.id)).rejects.toThrow('rolled back');
  serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}/messages`]: page,
    [`GET /api/v1/chats/${room.id}`]: newest,
  });
  await expect(client().open(room.id)).resolves.toMatchObject({ headVersion: 2 });
});
it('refuses an invalid form before sealing or sending', async () => {
  const room = await makeRoom();
  const seen = serve({ ...keysRoute, [`GET /api/v1/chats/${room.id}`]: room });
  const bad = { title: 'Pick', fields: [{ id: 'a', type: 'choice', label: 'A' }] };
  await expect(client().ask(room.id, bad)).rejects.toThrow(/type/);
  await expect(client().ask(room.id, { fields: [] })).rejects.toThrow(/title/);
  expect(seen).toEqual([]);
});
it('sends a valid form', async () => {
  const room = await makeRoom();
  const seen = serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}`]: room,
    [`POST /api/v1/chats/${room.id}/messages`]: { seq: 1, id: 'x' },
  });
  const form = {
    title: 'Pick',
    fields: [{ id: 'a', type: 'select', label: 'A', options: [{ value: 'y', label: 'Yes' }] }],
  };
  await client().ask(room.id, form);
  expect(seen.filter((s) => s.route.startsWith('POST'))).toHaveLength(1);
});
it('seals a summary, sends tags and refuses a long summary', async () => {
  const room = await makeRoom();
  const seen = serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}`]: room,
    [`POST /api/v1/chats/${room.id}/messages`]: { seq: 1, id: 'x' },
  });
  await client().send(room.id, 'long prompt', { sub: 'a', tags: ['b'], summary: 'Plan' });
  const post = seen.find((s) => s.route.startsWith('POST'))!;
  expect(post.body).toMatchObject({ sub: 'a', tags: ['b'] });
  expect(JSON.stringify(post)).not.toContain('Plan');
  const record = {
    ...{ seq: 1, id: post.body!.id as string, sender: agent, sub: 'a', at: 1 },
    ...{ kind: 'message' as const, audience: 'all' as const },
    envelope: post.body!.envelope as e2ee.SealedEnvelope,
  };
  serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}/messages`]: {
      messages: [record],
      through_seq: 1,
      hasMore: false,
    },
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  const { messages } = await client().read(room.id, { for: 'b' });
  expect(messages[0]).toMatchObject({ text: 'long prompt', summary: 'Plan', tags: ['b'] });
  const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
  expect(urls.some((u) => u.includes('/messages?for=b'))).toBe(true);
  await expect(client().send(room.id, 'x', { summary: 's'.repeat(201) })).rejects.toThrow(/200/);
});
it('seals tags with the message and leaves them out when empty', async () => {
  const room = await makeRoom();
  const seen = serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}`]: room,
    [`POST /api/v1/chats/${room.id}/messages`]: { seq: 1, id: 'x' },
  });
  await client().send(room.id, 'plain', { tags: [] });
  await client().send(room.id, 'to b', { tags: ['b', 'c'] });
  const posts = seen.filter((s) => s.route.startsWith('POST'));
  const opened = async (i: number) => {
    const body = posts[i].body!;
    const record = {
      ...{ seq: 1, id: body.id as string, sender: agent, sub: '', at: 1 },
      ...{ kind: 'message' as const, audience: 'all' as const },
      envelope: body.envelope as e2ee.SealedEnvelope,
    };
    return e2ee.openChat(await ownerKeys(), room.id, record);
  };
  expect(await opened(0)).not.toHaveProperty('tags');
  expect(await opened(1)).toMatchObject({ tags: ['b', 'c'] });
});
it('titles a room, and a new group when asked', async () => {
  const room = await makeRoom();
  const seen = serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}`]: room,
    [`POST /api/v1/chats/${room.id}/messages`]: { seq: 1, id: 'x' },
  });
  await client().title(room.id, 'Launch Checklist', { sub: 'lead' });
  const post = seen.find((s) => s.route.startsWith('POST'))!;
  expect(post.body).toMatchObject({ kind: 'title', sub: 'lead' });
  const empty = { messages: [], through_seq: 0, hasMore: false };
  const calls = serve({
    ...keysRoute,
    'GET /api/v1/chats/': () => {
      const route = calls.at(-1)!.route;
      return route.endsWith('/messages') ? empty : created;
    },
    'POST /api/v1/chats': async () => {
      const last = calls.at(-1)!;
      if (last.route.endsWith('/messages')) return { seq: 1, id: 'x' };
      const signed = last.body!.head as e2ee.SignedChatHead;
      created = {
        id: signed.head.room,
        kind: 'group',
        nonce: last.body!.nonce,
        head: await e2ee.headHash(signed.head),
        headVersion: 1,
        chain: [signed],
        lastSeq: 0,
        lastAt: 0,
        readSeq: 0,
        unread: 0,
        members: (await makeRoom()).members,
      };
      return created;
    },
  });
  let created: Record<string, unknown> = {};
  await client().group([human], { agents: ['lead'], title: 'Launch Checklist' });
  const titled = calls.find((s) => s.route.endsWith('/messages') && s.route.startsWith('POST'));
  expect(titled?.body).toMatchObject({ kind: 'title', sub: 'lead' });
});
it('names its agent on a reaction, an edit and an answer', async () => {
  const room = await makeRoom();
  const owner = await ownerKeys();
  const id = crypto.randomUUID();
  const fields = [{ id: 'a', type: 'select', label: 'A', options: [{ value: 'y', label: 'Yes' }] }];
  const form = { title: 'Pick', fields };
  const envelope = await e2ee.sealChat(owner, room, { id, text: '', kind: 'form', form });
  const record = { seq: 1, id, sender: human, sub: '', at: 1, kind: 'form', audience: 'all' };
  const seen = serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}/messages`]: {
      messages: [{ ...record, envelope }],
      through_seq: 1,
      hasMore: false,
    },
    [`GET /api/v1/chats/${room.id}`]: room,
    [`POST /api/v1/chats/${room.id}/messages`]: { seq: 2, id: 'x' },
  });
  await client().react(room.id, 1, '+1', { remove: true, sub: 'lead' });
  await client().edit(room.id, 1, 'fixed', { sub: 'lead' });
  await client().answer(room.id, 1, { a: 'y' }, { sub: 'qa' });
  const posts = seen.filter((s) => s.route.startsWith('POST')).map((s) => s.body);
  expect(posts[0]).toMatchObject({ kind: 'event', event: { type: 'reaction' }, sub: 'lead' });
  expect(posts[1]).toMatchObject({ kind: 'event', event: { type: 'edit' }, sub: 'lead' });
  expect(posts[2]).toMatchObject({ sub: 'qa' });
  const answered = {
    ...{ seq: 2, id: posts[2]!.id as string, sender: agent, sub: 'qa', at: 1 },
    kind: 'answer' as const,
  };
  const opened = await e2ee.openChat(owner, room.id, {
    ...answered,
    audience: 'all',
    envelope: posts[2]!.envelope as e2ee.SealedEnvelope,
  });
  expect(opened).toMatchObject({ answers: { a: 'y' } });
  expect((posts[2]!.envelope as e2ee.SealedEnvelope).ctx).toMatchObject({ sub: 'qa' });
});
it('lets an agent create a group owned by it and its people', async () => {
  const seen = serve({
    ...keysRoute,
    'POST /api/v1/chats': () => {
      const body = seen.at(-1)!.body!;
      const signed = body.head as e2ee.SignedChatHead;
      return {
        id: signed.head.room,
        kind: 'group',
        nonce: body.nonce,
        head: 'x',
        headVersion: 1,
        chain: [signed],
        lastSeq: 0,
        lastAt: 0,
        readSeq: 0,
        unread: 0,
        members: [],
      };
    },
  });
  await client()
    .group([human], { agents: ['lead'], hopLimit: 0 })
    .catch((e: Error) => e);
  const body = seen.find((s) => s.route === 'POST /api/v1/chats')!.body!;
  const signed = body.head as e2ee.SignedChatHead;
  expect(body).toMatchObject({
    kind: 'group',
    hopLimit: 0,
    agents: [{ connection: agent, key: 'lead' }],
  });
  expect(signed).toMatchObject({ by: agent, head: { owners: [agent, human] } });
  expect(signed.head.members).toEqual([agent, human]);
  expect(signed.head.room).toBe(await e2ee.groupRoomId(agent, body.nonce as string));
});
it("wakes a subagent with its sibling's messages", async () => {
  const { room } = await groupOf({ lastSeq: 1 });
  const empty = { messages: [], through_seq: 0, hasMore: false };
  const seen = serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}/messages`]: empty,
    [`GET /api/v1/chats/${room.id}`]: room,
    [`POST /api/v1/chats/${room.id}/messages`]: { seq: 1, id: 'x' },
  });
  await client().send(room.id, 'over to b', { sub: 'a', tags: ['b'] });
  const post = seen.find((s) => s.route.startsWith('POST'))!;
  const record = {
    ...{ seq: 1, id: post.body!.id as string, sender: agent, sub: 'a', at: 1 },
    ...{ kind: 'message' as const, audience: 'all' as const },
    envelope: post.body!.envelope as e2ee.SealedEnvelope,
  };
  const wake = { room: room.id, first: 1, seq: 1, reason: 'mention', subagent: 'b' };
  let leases = 0;
  const calls = serve({
    ...keysRoute,
    'GET /api/v1/chats/wakes': { wakes: [{ room: room.id, subagent: 'b' }] },
    [`POST /api/v1/chats/${room.id}/lease`]: () => ({
      wake: leases++ ? null : { ...wake, context: 'message', contextFrom: 1 },
    }),
    [`POST /api/v1/chats/${room.id}/ack`]: null,
    [`GET /api/v1/chats/${room.id}/messages`]: {
      messages: [record],
      through_seq: 1,
      hasMore: false,
    },
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  const h = new Herald({ apiKey: token, url });
  const parsed = e2ee.parseToken(token);
  const session = new KeyedSession(parsed.seed!, parsed.fingerprint!, () => h.request('/keys'));
  const socket = new FakeSocket();
  const chat = new ChatClient(
    (p, b, o) => h.request(p, b, o),
    () => session,
    () => socket,
    () => Promise.reject(new Error('unused')),
  );
  const got: string[] = [];
  const stop = new AbortController();
  const done = chat.wakes((w) => void got.push(...w.messages.map((m) => m.text)), {
    signal: stop.signal,
  });
  await flush();
  socket.handlers.get('open')?.();
  await flush();
  stop.abort();
  await done;
  expect(got).toEqual(['over to b']);
  // The subagent's own wake is leased and acked alone, and leaves the read mark to its connection.
  expect(calls.find((s) => s.route.endsWith('/lease'))!.body).toEqual({ subagent: 'b' });
  expect(calls.find((s) => s.route.endsWith('/ack'))!.body).toEqual({ seq: 1, subagent: 'b' });
});
it('signs the next group head as an agent owner', async () => {
  const keys = await ownerKeys();
  const id = await e2ee.groupRoomId(human, nonce);
  const first = await e2ee.signChatHead(keys, {
    ...{ room: id, version: 1, prev: '', owners: [human, agent], members: [human, agent] },
  });
  const { room } = await groupOf({ head: await e2ee.headHash(first.head), chain: [first] });
  const empty = { messages: [], through_seq: 0, hasMore: false };
  const seen = serve({
    ...keysRoute,
    [`GET /api/v1/chats/${id}/messages`]: empty,
    [`POST /api/v1/chats/${id}/heads`]: new Response('{"error":"stop"}', { status: 418 }),
    [`GET /api/v1/chats/${id}`]: room,
  });
  await expect(client().updateGroup(id, { add: ['a:two'] })).rejects.toThrow();
  const signed = seen.find((s) => s.route.endsWith('/heads'))!
    .body as unknown as e2ee.SignedChatHead;
  expect(signed).toMatchObject({ by: agent, head: { version: 2, prev: room.head } });
  expect(signed.head.members).toEqual([human, agent, 'a:two']);
  expect(signed.head.owners).toEqual([human, agent]);
});
const withSocket = (socket: FakeSocket) => {
  const h = new Herald({ apiKey: token, url });
  const parsed = e2ee.parseToken(token);
  const session = new KeyedSession(parsed.seed!, parsed.fingerprint!, () => h.request('/keys'));
  return new ChatClient(
    (p, b, o) => h.request(p, b, o),
    () => session,
    () => socket,
    () => Promise.reject(new Error('unused')),
  );
};
it('lists rooms with the title opened and without chains', async () => {
  const room = await makeRoom();
  const id = crypto.randomUUID();
  const envelope = await e2ee.sealChat(await ownerKeys(), room, {
    id,
    text: 'Launch',
    kind: 'title',
  });
  const title = {
    seq: 1,
    id,
    sender: human,
    sub: '',
    at: 1,
    kind: 'title',
    audience: 'all',
    envelope,
  };
  serve({
    ...keysRoute,
    'GET /api/v1/chats': { rooms: [{ ...room, title, lastSeq: 1, unread: 2, chain: [] }] },
  });
  expect(await client().list()).toEqual([
    { id: room.id, kind: 'dm', title: 'Launch', unread: 2, lastSeq: 1, members: room.members },
  ]);
});
it('next takes the oldest wake of any subagent and acks it as that subagent', async () => {
  const room = await makeRoom();
  const m1 = await fromOwner(room, 1, 'hi');
  const wake = { room: room.id, first: 1, seq: 1, reason: 'mention', context: 'message' };
  const seen = serve({
    ...keysRoute,
    [`POST /api/v1/chats/${room.id}/lease`]: { wake: { ...wake, contextFrom: 1, subagent: 'b' } },
    [`POST /api/v1/chats/${room.id}/ack`]: { readSeq: 1 },
    [`GET /api/v1/chats/${room.id}/messages`]: { messages: [m1], through_seq: 1, hasMore: false },
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  const got = await client().next(room.id, { timeout: 1 });
  expect(got).toMatchObject({ subagent: 'b', messages: [{ text: 'hi' }] });
  expect(seen.find((s) => s.route.endsWith('/lease'))!.body).toEqual({});
  expect(seen.find((s) => s.route.endsWith('/ack'))!.body).toEqual({ seq: 1, subagent: 'b' });
});
it('next fails on a refused lease instead of waiting out the timeout', async () => {
  const room = await makeRoom();
  serve({
    ...keysRoute,
    [`POST /api/v1/chats/${room.id}/lease`]: Response.json({ error: 'No.' }, { status: 403 }),
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  await expect(client().next(room.id, { timeout: 5 })).rejects.toMatchObject({ status: 403 });
});
it('wait reads back messages that landed before the socket opened', async () => {
  const room = await makeRoom();
  const m1 = await fromOwner(room, 1, 'one');
  const empty = { messages: [], through_seq: 0, hasMore: false };
  let reads = 0;
  serve({
    ...keysRoute,
    [`POST /api/v1/chats/${room.id}/ack`]: { readSeq: 1 },
    [`GET /api/v1/chats/${room.id}/messages`]: () =>
      reads++ ? { messages: [m1], through_seq: 1, hasMore: false } : empty,
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  const socket = new FakeSocket();
  const got = withSocket(socket).wait(room.id, { after: 0, timeout: 1 });
  await flush();
  socket.handlers.get('open')?.();
  expect((await got).map((m) => m.text)).toEqual(['one']);
});
it('wait ignores messages that could not be verified', async () => {
  const room = await makeRoom();
  const spoofed = { ...(await fromOwner(room, 1)), sender: agent };
  const seen = serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}/messages`]: {
      messages: [spoofed],
      through_seq: 1,
      hasMore: false,
    },
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  expect(await withSocket(new FakeSocket()).wait(room.id, { after: 0, timeout: 0.05 })).toEqual([]);
  expect(seen.some((s) => s.route.endsWith('/ack'))).toBe(false);
});
it('seals names for sub and tags, filled from registered agents', async () => {
  const room = await makeRoom();
  const seen = serve({
    ...keysRoute,
    'PUT /api/v1/agents/me/subagents/': { expiresAt: 5 },
    [`GET /api/v1/chats/${room.id}`]: room,
    [`POST /api/v1/chats/${room.id}/messages`]: { seq: 1, id: 'x' },
  });
  const herald = new Herald({ apiKey: token, url });
  await herald.agents.register('lead', { name: 'Lead', state: 'idle' });
  await herald.chat.send(room.id, 'go', {
    sub: 'lead',
    tags: ['b', 'c'],
    names: { b: 'Bee', z: 'Z' },
  });
  await expect(herald.chat.send(room.id, 'x', { tags: ['b'], names: { b: '' } })).rejects.toThrow(
    /60/,
  );
  const body = seen.filter((s) => s.route.startsWith('POST')).at(-1)!.body!;
  expect(JSON.stringify(body)).not.toContain('Lead');
  const record = {
    ...{ seq: 1, id: body.id as string, sender: agent, sub: 'lead', at: 1 },
    ...{ kind: 'message' as const, audience: 'all' as const },
    envelope: body.envelope as e2ee.SealedEnvelope,
  };
  const opened = await e2ee.openChat(await ownerKeys(), room.id, record);
  expect(opened).toMatchObject({ names: { lead: 'Lead', b: 'Bee' } });
  expect(JSON.stringify(opened)).not.toContain('"z"');
  serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}/messages`]: {
      messages: [record],
      through_seq: 1,
      hasMore: false,
    },
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  const { messages } = await client().read(room.id);
  expect(messages[0].names).toEqual({ lead: 'Lead', b: 'Bee' });
});
it('opens agent DMs and adds or removes room agents', async () => {
  const room = await makeRoom();
  const seen = serve({
    ...keysRoute,
    'POST /api/v1/chats': room,
    [`PUT /api/v1/chats/${room.id}/agents/lead`]: room,
    [`DELETE /api/v1/chats/${room.id}/agents/lead`]: room,
  });
  const chat = client();
  await chat.open(human, { agent: 'lead' });
  await chat.addAgent(room.id, 'lead', { notify: 'all' });
  await chat.removeAgent(room.id, 'lead');
  const posts = seen.filter((s) => s.route === 'POST /api/v1/chats');
  expect(posts.map((p) => p.body)).toEqual([{ kind: 'dm', with: human, agent: 'lead' }]);
  expect(seen.find((s) => s.route.startsWith('PUT'))!.body).toEqual({ notify: 'all' });
  expect(seen.some((s) => s.route === `DELETE /api/v1/chats/${room.id}/agents/lead`)).toBe(true);
});
it('archives, unarchives and deletes a room', async () => {
  const room = await makeRoom();
  const archived = { ...room, archivedAt: 5 };
  const seen = serve({
    ...keysRoute,
    [`PUT /api/v1/chats/${room.id}/archived`]: archived,
    [`DELETE /api/v1/chats/${room.id}`]: {},
  });
  const chat = client();
  expect((await chat.archive(room.id)).archivedAt).toBe(5);
  await chat.unarchive(room.id);
  await chat.deleteRoom(room.id);
  expect(seen.filter((s) => s.route.startsWith('PUT')).map((s) => s.body)).toEqual([
    { archived: true },
    { archived: false },
  ]);
  expect(seen.some((s) => s.route === `DELETE /api/v1/chats/${room.id}`)).toBe(true);
});
it('forgets a room after a delete, a missing room or a deleted frame', async () => {
  const { room: v1, signed, owner } = await groupOf();
  const next = await e2ee.signChatHead(owner, { ...signed.head, version: 2, prev: v1.head });
  const v2 = { ...v1, head: await e2ee.headHash(next.head), headVersion: 2, chain: [signed, next] };
  let live: e2ee.ChatRoom = v2;
  let reply: Response | object = {};
  serve({
    ...keysRoute,
    [`GET /api/v1/chats/${v1.id}/messages`]: { messages: [], through_seq: 0, hasMore: false },
    [`GET /api/v1/chats/${v1.id}`]: () => live,
    [`DELETE /api/v1/chats/${v1.id}`]: () => reply,
  });
  const socket = new FakeSocket();
  const chat = withSocket(socket);
  // A pinned newer head makes the older one read as a rollback until the room is forgotten.
  const rolledBack = async () => {
    live = v1;
    const out = await chat.open(v1.id).then(
      () => false,
      () => true,
    );
    live = v2;
    return out;
  };
  const stop = new AbortController();
  const done = chat.wakes(() => {}, { signal: stop.signal });
  for (const how of ['ok', '404', 'frame']) {
    await chat.open(v1.id);
    expect(await rolledBack()).toBe(true);
    if (how === 'frame') socket.emit({ type: 'deleted', room: v1.id });
    else {
      reply = how === '404' ? Response.json({ code: 'CHAT_NOT_FOUND' }, { status: 404 }) : {};
      await chat.deleteRoom(v1.id).catch(() => undefined);
    }
    expect(await rolledBack()).toBe(false);
    await chat.open(v1.id).catch(() => undefined);
    live = v2;
  }
  stop.abort();
  socket.close();
  await done;
});
it('surfaces CHAT_ARCHIVED on a refused send', async () => {
  const room = await makeRoom({ archivedAt: 5 });
  serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}`]: room,
    [`POST /api/v1/chats/${room.id}/messages`]: Response.json(
      { error: 'This chat is archived.', code: 'CHAT_ARCHIVED' },
      { status: 409 },
    ),
  });
  await expect(client().send(room.id, 'hi')).rejects.toMatchObject({
    status: 409,
    code: 'CHAT_ARCHIVED',
  });
});
it('requires an agent to open a person, and has no session rooms', async () => {
  const seen = serve({ ...keysRoute });
  const chat = client();
  for (const target of [human, 'owner', 'a:other'])
    await expect(chat.open(target as string, undefined as never)).rejects.toMatchObject({
      status: 400,
      code: 'AGENT_REQUIRED',
    });
  expect(seen.some((s) => s.route === 'POST /api/v1/chats')).toBe(false);
  expect('session' in chat).toBe(false);
});
it('opens the agent DM with sub when sending to a person or owner', async () => {
  const room = await makeRoom();
  const seen = serve({
    ...keysRoute,
    [`POST /api/v1/chats/${room.id}/messages`]: { seq: 1, id: 'x' },
    'POST /api/v1/chats': room,
  });
  const chat = client();
  await chat.send(human, 'hi', { sub: 'lead' });
  await chat.send('owner', 'hi', { sub: 'lead' });
  const dms = seen.filter((s) => s.route === 'POST /api/v1/chats');
  expect(dms.map((d) => d.body)).toEqual([
    { kind: 'dm', with: human, agent: 'lead' },
    { kind: 'dm', with: 'owner', agent: 'lead' },
  ]);
  expect(
    seen.filter((s) => s.route.endsWith('/messages')).every((s) => s.body?.sub === 'lead'),
  ).toBe(true);
  await expect(chat.send(human, 'hi')).rejects.toMatchObject({ code: 'AGENT_REQUIRED' });
  const form = {
    title: 'Pick',
    fields: [{ id: 'a', type: 'select', label: 'A', options: [{ value: 'y', label: 'Yes' }] }],
  };
  await expect(chat.ask('owner', form)).rejects.toMatchObject({ code: 'AGENT_REQUIRED' });
  expect(dms).toHaveLength(2);
});
it('resolves owner through the DM for reading and waiting, and requires the agent', async () => {
  const room = await makeRoom();
  const m1 = await fromOwner(room, 1, 'hi');
  const wake = { room: room.id, first: 1, seq: 1, reason: 'message', context: 'message' };
  const seen = serve({
    ...keysRoute,
    [`POST /api/v1/chats/${room.id}/lease`]: { wake: { ...wake, contextFrom: 1 } },
    [`POST /api/v1/chats/${room.id}/ack`]: { readSeq: 1 },
    [`GET /api/v1/chats/${room.id}/messages`]: { messages: [m1], through_seq: 1, hasMore: false },
    [`GET /api/v1/chats/${room.id}`]: room,
    'POST /api/v1/chats': room,
  });
  const chat = client();
  expect((await chat.next('owner', { timeout: 1, for: 'lead' }))?.messages).toHaveLength(1);
  expect(await chat.wait(human, { timeout: 1, for: 'lead' })).toHaveLength(1);
  expect(await chat.wait('owner', { after: 0, timeout: 1, for: 'lead' })).toHaveLength(1);
  expect((await chat.read('owner', { for: 'lead' })).messages).toHaveLength(1);
  const dms = seen.filter((s) => s.route === 'POST /api/v1/chats').map((s) => s.body);
  expect(dms).toEqual([
    { kind: 'dm', with: 'owner', agent: 'lead' },
    { kind: 'dm', with: human, agent: 'lead' },
    { kind: 'dm', with: 'owner', agent: 'lead' },
    { kind: 'dm', with: 'owner', agent: 'lead' },
  ]);
  for (const call of [
    () => chat.next('owner', { timeout: 1 }),
    () => chat.wait('owner', { timeout: 1 }),
    () => chat.wait('a:other', { after: 0, timeout: 1 }),
    () => chat.read('owner'),
  ])
    await expect(call()).rejects.toMatchObject({ status: 400, code: 'AGENT_REQUIRED' });
  expect(seen.filter((s) => s.route === 'POST /api/v1/chats')).toHaveLength(4);
});
it('resolves owner through the DM for answer, delete and attach, and requires sub', async () => {
  const room = await makeRoom();
  const owner = await ownerKeys();
  const id = crypto.randomUUID();
  const fields = [{ id: 'a', type: 'select', label: 'A', options: [{ value: 'y', label: 'Yes' }] }];
  const envelope = await e2ee.sealChat(owner, room, {
    id,
    text: '',
    kind: 'form',
    form: { title: 'Pick', fields },
  });
  const record = { seq: 1, id, sender: human, sub: '', at: 1, kind: 'form', audience: 'all' };
  const seen = serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}/messages`]: {
      messages: [{ ...record, envelope }],
      through_seq: 1,
      hasMore: false,
    },
    [`POST /api/v1/chats/${room.id}/messages/1/response`]: { seq: 2, id: 'x' },
    [`DELETE /api/v1/chats/${room.id}/messages/1`]: null,
    [`POST /api/v1/chats/${room.id}/files`]: { id: 'f1' },
    [`PUT /api/v1/chats/${room.id}/files/f1`]: new Response(null),
    [`GET /api/v1/chats/${room.id}`]: room,
    'POST /api/v1/chats': room,
  });
  const chat = client();
  await chat.answer('owner', 1, { a: 'y' }, { sub: 'qa' });
  await chat.delete(human, 1, { sub: 'lead' });
  const file = await chat.attach('owner', 'a.txt', new Uint8Array([1]), 'text/plain', {
    sub: 'lead',
  });
  expect(file.id).toBe('f1');
  const dms = seen.filter((s) => s.route === 'POST /api/v1/chats').map((s) => s.body);
  expect(dms).toEqual([
    { kind: 'dm', with: 'owner', agent: 'qa' },
    { kind: 'dm', with: human, agent: 'lead' },
    { kind: 'dm', with: 'owner', agent: 'lead' },
  ]);
  for (const call of [
    () => chat.answer('owner', 1, { a: 'y' }),
    () => chat.delete('a:other', 1),
    () => chat.attach('owner', 'a.txt', new Uint8Array([1])),
  ])
    await expect(call()).rejects.toMatchObject({ status: 400, code: 'AGENT_REQUIRED' });
  expect(seen.filter((s) => s.route === 'POST /api/v1/chats')).toHaveLength(3);
});
it('download and updateGroup take a room id only', async () => {
  const seen = serve({ ...keysRoute });
  const file = { id: 'f1', name: 'a', type: 't', size: 1, key: 'k' };
  await expect(client().download('owner', file)).rejects.toMatchObject({ status: 400 });
  await expect(client().updateGroup('owner', { add: [human] })).rejects.toMatchObject({
    status: 400,
  });
  expect(seen.filter((s) => s.route !== 'GET /api/v1/keys')).toEqual([]);
});
it('sends the agents of a new group with their connections', async () => {
  const seen = serve({
    ...keysRoute,
    'POST /api/v1/chats': () => {
      throw new Error('stop');
    },
  });
  await client()
    .group([human, 'a:other'], {
      agents: ['lead', { connection: 'a:other', key: 'r', notify: 'all' }],
    })
    .catch((e: Error) => e);
  const body = seen.find((s) => s.route === 'POST /api/v1/chats')!.body!;
  expect(body.agents).toEqual([
    { connection: agent, key: 'lead' },
    { connection: 'a:other', key: 'r', notify: 'all' },
  ]);
});

const statusFromOwner = async (room: e2ee.ChatRoom, status: object, kind = 'status') => {
  const owner = await ownerKeys();
  const id = crypto.randomUUID();
  const envelope = await e2ee.sealChat(owner, room, {
    id,
    text: '',
    kind: kind as 'status',
    status,
  });
  return { seq: 0, id, sender: human, sub: '', at: 7, kind, audience: 'all', envelope };
};
it('sets a status sealed to the room, takes busy as working, and clears it', async () => {
  const room = await makeRoom();
  const seen = serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}`]: room,
    [`PUT /api/v1/chats/${room.id}/status`]: room,
    [`DELETE /api/v1/chats/${room.id}/status`]: room,
  });
  const chat = client();
  await chat.setStatus(room.id, { state: 'busy', text: 'Migrating' });
  await chat.setStatus(room.id, null);
  await expect(chat.setStatus(room.id, { state: 'offline' as 'idle' })).rejects.toThrow(/idle/);
  await expect(chat.setStatus(room.id, { state: 'idle', text: 'x'.repeat(121) })).rejects.toThrow(
    /120/,
  );
  const put = seen.find((s) => s.route.startsWith('PUT'))!;
  expect(JSON.stringify(put)).not.toContain('Migrating');
  expect(Object.keys(put.body!).sort()).toEqual(['envelope', 'headVersion', 'id']);
  const env = put.body!.envelope as e2ee.SealedEnvelope;
  expect(env.to.map((r) => r.kid).sort()).toEqual(room.members.map((m) => m.kid).sort());
  const record = {
    seq: 0,
    id: put.body!.id as string,
    sender: agent,
    sub: '',
    at: 1,
    kind: 'status' as const,
    audience: 'all' as const,
    envelope: env,
  };
  expect(await e2ee.openChat(await ownerKeys(), room.id, record)).toMatchObject({
    kind: 'status',
    status: { state: 'working', text: 'Migrating' },
  });
  expect(seen.some((s) => s.route === `DELETE /api/v1/chats/${room.id}/status`)).toBe(true);
});
it('reads a status from the room and the listing, dropping unknown or forged ones', async () => {
  const base = await makeRoom();
  const good = await statusFromOwner(base, { state: 'blocked', text: 'Needs input' });
  const room = { ...base, status: good } as e2ee.ChatRoom;
  serve({
    ...keysRoute,
    [`GET /api/v1/chats/${room.id}`]: room,
    'GET /api/v1/chats?': { rooms: [room] },
    'GET /api/v1/chats': { rooms: [room] },
  });
  const chat = client();
  expect(await chat.status(room.id)).toEqual({
    state: 'blocked',
    text: 'Needs input',
    by: human,
    at: 7,
  });
  expect((await chat.list())[0].status).toMatchObject({ state: 'blocked' });
  vi.restoreAllMocks();
  const later = await statusFromOwner(base, { state: 'asleep' });
  const odd = { ...base, status: later } as e2ee.ChatRoom;
  serve({ ...keysRoute, [`GET /api/v1/chats/${odd.id}`]: odd });
  expect(await client().status(odd.id)).toBeUndefined();
  vi.restoreAllMocks();
  const forged = { ...good, sender: agent };
  serve({ ...keysRoute, [`GET /api/v1/chats/${room.id}`]: { ...room, status: forged } });
  expect(await client().status(room.id)).toBeUndefined();
});
it('wakes passes status frames to onRoom, opened, and drops ones that do not verify', async () => {
  const room = await makeRoom();
  const good = await statusFromOwner(room, { state: 'error', text: 'Failed' });
  const keys = await ownerKeys();
  const keyed = { state: async () => ({ ws: false }), chatKeys: async () => keys } as never;
  const socket = new FakeSocket();
  const request = (async (path: string) => {
    if (path === `/chats/${room.id}`) return room;
    throw new Error('unused ' + path);
  }) as never;
  const chat = new ChatClient(
    request,
    () => keyed,
    () => socket,
    () => Promise.reject(new Error('unused')),
  );
  const stop = new AbortController();
  const got: unknown[] = [];
  const done = chat.wakes(() => {}, { signal: stop.signal, onRoom: (e) => void got.push(e) });
  socket.emit({ type: 'status', room: room.id, status: good });
  socket.emit({ type: 'status', room: room.id, status: { ...good, sender: agent } });
  socket.emit({ type: 'status', room: room.id, status: null });
  await flush();
  expect(got).toEqual([
    { room: room.id, status: { state: 'error', text: 'Failed', by: human, at: 7 } },
    { room: room.id, status: null },
    { room: room.id, status: null },
  ]);
  stop.abort();
  socket.close();
  await done;
});
it('wakes refreshes keys once to open a status, then reports one it cannot open', async () => {
  const room = await makeRoom();
  const good = await statusFromOwner(room, { state: 'blocked', text: 'Input' });
  const keys = await ownerKeys();
  let fresh = false;
  const keyed = {
    state: async (refresh: boolean) => {
      if (refresh) fresh = true;
      return { ws: false };
    },
    // Before a refresh the cached directory does not know the signer.
    chatKeys: async () => (fresh ? keys : { ...keys, verifier: () => undefined }),
  } as never;
  const socket = new FakeSocket();
  const request = (async (path: string) => {
    if (path === `/chats/${room.id}`) return room;
    throw new Error('unused ' + path);
  }) as never;
  const chat = new ChatClient(
    request,
    () => keyed,
    () => socket,
    () => Promise.reject(new Error('unused')),
  );
  const stop = new AbortController();
  const got: unknown[] = [];
  const errors: unknown[] = [];
  const done = chat.wakes(() => {}, {
    signal: stop.signal,
    onRoom: (e) => void got.push(e),
    onError: (e) => void errors.push(e),
  });
  socket.emit({ type: 'status', room: room.id, status: good });
  await flush();
  expect(got).toEqual([
    { room: room.id, status: { state: 'blocked', text: 'Input', by: human, at: 7 } },
  ]);
  expect(errors).toEqual([]);
  socket.emit({ type: 'status', room: room.id, status: { ...good, sender: agent } });
  await flush();
  expect(got.at(-1)).toEqual({ room: room.id, status: null });
  expect(errors).toHaveLength(1);
  stop.abort();
  socket.close();
  await done;
});
