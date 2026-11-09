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
    seen.push({ route, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((r) => route.startsWith(r));
    if (!key) return Response.json({ error: 'Not found.' }, { status: 404 });
    const value = routes[key];
    const out = typeof value === 'function' ? (value as () => unknown)() : value;
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
    [`POST /api/v1/chats/${room.id}/read`]: { readSeq: 1 },
    [`GET /api/v1/chats/${room.id}/messages`]: { messages: [m1], through_seq: 1, hasMore: false },
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  const got = await client().wait(room.id, { after: 0, timeout: 1 });
  expect(got.map((m) => m.text)).toEqual(['one']);
  expect(seen.some((s) => s.route.endsWith('/lease'))).toBe(false);
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
    [`POST /api/v1/chats/${room.id}/read`]: { readSeq: 2 },
    [`GET /api/v1/chats/${room.id}/messages`]: {
      messages: [m2],
      through_seq: 2,
      hasMore: false,
    },
    [`GET /api/v1/chats/${room.id}`]: room,
  });
  const got = await client().wait(room.id, { timeout: 1 });
  expect(got.map((m) => m.text)).toEqual(['two']);
  expect(seen.find((s) => s.route.endsWith('/read'))!.body).toEqual({ seq: 2 });
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
    [`POST /api/v1/chats/${room.id}/read`]: { readSeq: 1 },
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
  socket.emit({ type: 'wake', room: room.id, seq: 1 });
  await flush();
  socket.emit({ type: 'message', room: room.id, prev: 1, ...m2 });
  await flush();
  // A duplicate is ignored; seq 4 with prev 3 is a gap and is read back.
  socket.emit({ type: 'message', room: room.id, prev: 1, ...m2 });
  socket.emit({ type: 'message', room: room.id, prev: 3, seq: 4, hint: true });
  await flush();
  stop.abort();
  await done;
  expect(got.map((m) => m.text)).toEqual(['one', 'two', 'four']);
  const acks = seen.filter((s) => s.route.endsWith('/read')).map((s) => s.body!.seq);
  expect(acks).toEqual([1, 2, 4]);
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
    [`POST /api/v1/chats/${room.id}/read`]: { readSeq: 1 },
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
