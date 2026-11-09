import type {
  ChatAttachment,
  ChatEvent,
  ChatKeys,
  ChatRecord,
  ChatRoom,
  OpenedChat,
  RoomTrust,
} from './e2ee/index.js';
import * as e2ee from './e2ee/index.js';
import { HeraldError, readError, sleep } from './http.js';
import type { KeyedSession } from './keyed.js';
import { backoff, KEEPALIVE, type EventSocket } from './socket.js';
export type { ChatRoom } from './e2ee/index.js';
/** An opened chat message; `locked` when it could not be decrypted or verified. */
export type ChatMessage = Omit<ChatRecord, 'envelope' | 'secrets' | 'event'> & {
  room: string;
  text: string;
  mine: boolean;
  locked?: boolean;
  event?: ChatEvent;
  form?: Record<string, unknown>;
  answers?: Record<string, unknown>;
  /** Secret form answers; only their asker can open them. */
  secrets?: Record<string, unknown>;
  attachments?: ChatAttachment[];
  reference?: Record<string, unknown>;
  /** The declared mentions differ from the signed ones, which `mentions` holds. */
  mentionsMismatch?: true;
  /** The runtime subagent the sender tagged, when this connection owns it. */
  subagent?: string;
};
export type WakeReason = 'form_answer' | 'mention' | 'reply' | 'message';
/** One handled batch: new `messages` from others, and earlier `history` per the context mode. */
export type ChatWake = {
  room: string;
  first: number;
  seq: number;
  reason: WakeReason;
  context: e2ee.ContextMode;
  contextFrom: number;
  messages: ChatMessage[];
  history: ChatMessage[];
};
export type ChatPage = { messages: ChatMessage[]; through_seq: number; hasMore: boolean };
export type ChatSendOptions = {
  audience?: 'all' | 'humans';
  sub?: string;
  replyTo?: number;
  id?: string;
  signal?: AbortSignal;
  mentions?: string[];
  attachments?: ChatAttachment[];
  /** A quoted snapshot of an Inbox request, sealed with the message. */
  reference?: Record<string, unknown>;
};
export type ChatFormRules = { deadline?: number; answerers?: 'humans' | 'any' };
type Request = <T>(
  path: string,
  body?: unknown,
  options?: { idempotencyKey?: string; signal?: AbortSignal; method?: string },
) => Promise<T>;
type Raw = (path: string, init: RequestInit) => Promise<Response>;
type Lease = Omit<ChatWake, 'messages' | 'history'>;
/** What a kind of message adds to the sealed payload and to the cleartext body. */
type Posted = {
  kind?: 'message' | 'form' | 'event';
  event?: ChatEvent;
  form?: Record<string, unknown>;
  rules?: ChatFormRules;
};
type Frame =
  | (ChatRecord & { type: 'message'; room: string; prev: number; hint?: true; subagent?: string })
  | {
      type: 'wake' | 'read';
      room: string;
      seq: number;
      subagent?: string;
    };
type Socketed = { type?: string; room?: string };
const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const RECENT = 20;
const PAGE = 100;
const path = (room: string) => '/chats/' + encodeURIComponent(room);
const ROOM_ID = /^[\w-]{43}$/;
/** Decrypted chat for one connection: rooms are verified and every message is opened locally. */
export class ChatClient {
  #request: Request;
  #keyed: () => KeyedSession;
  #connect: () => EventSocket;
  #raw: Raw;
  /** Newest head verified per group, so the server cannot roll one back during this process. */
  #pins = new Map<string, { version: number; hash: string }>();
  #heads = new Map<string, ReadonlySet<string> | null>();
  #recent = new Map<string, Set<string>>();
  constructor(request: Request, keyed: () => KeyedSession, connect: () => EventSocket, raw: Raw) {
    this.#request = request;
    this.#keyed = keyed;
    this.#connect = connect;
    this.#raw = raw;
  }
  #keys = (refresh: boolean | 'force' = false): Promise<ChatKeys> =>
    this.#keyed().chatKeys(refresh);
  /** Rooms the connection can verify, newest first; others are left out. */
  async list(options: { before?: number; limit?: number } = {}): Promise<ChatRoom[]> {
    const query = new URLSearchParams();
    if (options.before !== undefined) query.set('before', String(options.before));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const q = query.size ? '?' + query : '';
    const { rooms } = await this.#request<{ rooms: ChatRoom[] }>('/chats' + q);
    const keys = await this.#keys(true);
    const out: ChatRoom[] = [];
    for (const room of rooms)
      if (
        await e2ee.verifyChatRoom(keys, room, this.#trust(room.id)).then(
          () => true,
          () => false,
        )
      )
        out.push(room);
    return out;
  }
  /** The room for an id, or the DM with `h:…`, `a:…` or `owner`, created if needed. */
  async open(target: string): Promise<ChatRoom> {
    const room = ROOM_ID.test(target)
      ? await this.#request<ChatRoom>(path(target))
      : await this.#request<ChatRoom>('/chats', { kind: 'dm', with: target });
    return this.#verified(room);
  }
  /** A new session room with a principal. */
  async session(target: string): Promise<ChatRoom> {
    const nonce = e2ee.b64u.encode(crypto.getRandomValues(new Uint8Array(16)));
    return this.#verified(
      await this.#request<ChatRoom>('/chats', { kind: 'session', with: target, nonce }),
    );
  }
  #trust = (room: string): RoomTrust => ({
    pins: this.#pins,
    vouched: (hash) => !!this.#recent.get(room)?.has(hash),
  });
  /** Heads named by messages that verify; a stateless client takes the newest from these. */
  async #recentHeads(room: ChatRoom): Promise<Set<string>> {
    const known = this.#recent.get(room.id);
    if (known) return known;
    const page = await this.#request<{ messages: ChatRecord[] }>(
      `${path(room.id)}/messages?limit=${RECENT}`,
    );
    const keys = await this.#keys();
    const heads = new Set<string>();
    for (const record of page.messages) {
      if (!record.envelope) continue;
      const opened = await e2ee.openChat(keys, room.id, record).then(
        () => true,
        () => false,
      );
      if (opened) heads.add(String(record.envelope.ctx.head));
    }
    this.#recent.set(room.id, heads);
    return heads;
  }
  async #verified(room: ChatRoom): Promise<ChatRoom> {
    const group = room.kind === 'group';
    const recent = group ? await this.#recentHeads(room) : undefined;
    const trust = this.#trust(room.id);
    await e2ee.verifyChatRoom(await this.#keys(), room, trust).catch(async () => {
      await e2ee.verifyChatRoom(await this.#keys('force'), room, trust);
    });
    const heads = group ? await e2ee.roomHeads(room) : null;
    if (recent && heads && [...recent].some((h) => !heads.has(h)))
      throw new e2ee.E2eeError('The group head was rolled back.');
    this.#heads.set(room.id, heads);
    return room;
  }
  async #headsOf(room: string, refresh: boolean) {
    if (!this.#heads.has(room) || (refresh && this.#heads.get(room))) await this.open(room);
    return this.#heads.get(room) ?? undefined;
  }
  async #open(room: string, record: ChatRecord, keys: ChatKeys): Promise<ChatMessage> {
    const base = { ...record } as Partial<ChatRecord>;
    delete base.envelope;
    delete base.secrets;
    delete base.event;
    const mine = record.sender === keys.principal;
    const out = { ...base, room, mine, text: '' } as ChatMessage;
    if (!record.envelope) return out;
    let payload: OpenedChat | undefined;
    let current = keys;
    for (const refresh of [false, true]) {
      try {
        if (refresh) current = await this.#keys(true);
        const heads = await this.#headsOf(room, refresh);
        payload = await e2ee.openChat(current, room, record, heads ? { heads } : {});
        break;
      } catch {
        // A new connection's certificate or group head may be newer than the cached view.
      }
    }
    if (!payload) return { ...out, locked: true };
    const { text, event, form, answers, attachments, reference, mentions, mentionsMismatch } =
      payload;
    const sealed = await e2ee.openChatSecrets(current, room, record).catch(() => undefined);
    return {
      ...out,
      text,
      ...defined({
        event,
        form,
        answers,
        attachments,
        reference,
        mentions,
        mentionsMismatch,
        secrets: sealed?.answers as Record<string, unknown> | undefined,
      }),
    };
  }
  /** One page, oldest first; pass `after` to read forward and `before` to read back. */
  async read(
    room: string,
    options: { after?: number; before?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChatPage> {
    const query = new URLSearchParams();
    if (options.after !== undefined) query.set('after', String(options.after));
    if (options.before !== undefined) query.set('before', String(options.before));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const q = query.size ? '?' + query : '';
    const page = await this.#request<Omit<ChatPage, 'messages'> & { messages: ChatRecord[] }>(
      `${path(room)}/messages${q}`,
      undefined,
      { signal: options.signal },
    );
    const keys = await this.#keys();
    const messages: ChatMessage[] = [];
    for (const record of page.messages) messages.push(await this.#open(room, record, keys));
    return { ...page, messages };
  }
  /** Seals to the room's verified members; a stale room is refreshed and resealed once. */
  send(target: string, text: string, options: ChatSendOptions = {}) {
    return this.#post(target, text, options);
  }
  /** Asks a form in the chat; the first permitted answer closes it. */
  ask(
    target: string,
    form: Record<string, unknown>,
    options: ChatSendOptions & ChatFormRules = {},
  ) {
    const { deadline, answerers, ...rest } = options;
    return this.#post(target, '', rest, { kind: 'form', form, rules: { deadline, answerers } });
  }
  react(target: string, seq: number, emoji: string, remove = false) {
    const event: ChatEvent = {
      type: 'reaction',
      target: seq,
      emoji,
      ...(remove ? { remove: true } : {}),
    };
    return this.#post(target, '', {}, { kind: 'event', event });
  }
  /** Replaces a message's text; only its sender's edit counts. */
  edit(target: string, seq: number, text: string) {
    return this.#post(target, text, {}, { kind: 'event', event: { type: 'edit', target: seq } });
  }
  /** Removes a message's content, leaving a tombstone. */
  async delete(target: string, seq: number): Promise<void> {
    const room = await this.open(target);
    await this.#request(`${path(room.id)}/messages/${seq}`, undefined, { method: 'DELETE' });
  }
  async #post(target: string, text: string, options: ChatSendOptions, extra: Posted = {}) {
    const id = options.id ?? crypto.randomUUID();
    const { audience, sub, replyTo, mentions, attachments, reference, signal } = options;
    const { kind, event, form, rules } = extra;
    for (let attempt = 0; ; attempt++) {
      const room = await this.open(target);
      const keys = await this.#keys(attempt ? 'force' : false);
      const input = {
        id,
        text,
        ...defined({ kind, audience, sub, mentions, attachments, reference, event, form }),
      };
      const body = {
        id,
        envelope: await e2ee.sealChat(keys, room, input, this.#trust(room.id)),
        headVersion: room.headVersion,
        ...defined({ audience, replyTo, kind, mentions }),
        ...(sub ? { sub } : {}),
        ...(attachments?.length ? { attachments: attachments.map((a) => a.id) } : {}),
        ...(event ? { event: { type: event.type, target: event.target } } : {}),
        ...(form ? { form: defined(rules ?? {}) } : {}),
      };
      try {
        const sent = await this.#request<{ seq: number; id: string; duplicate?: true }>(
          `${path(room.id)}/messages`,
          body,
          { idempotencyKey: id, signal },
        );
        return { ...sent, room: room.id };
      } catch (error) {
        if (attempt || !(error instanceof HeraldError) || error.code !== 'ROOM_STALE') throw error;
      }
    }
  }
  /** Answers a form; `secrets` are sealed to the asker alone. */
  async answer(
    target: string,
    seq: number,
    answers: Record<string, unknown>,
    options: { secrets?: Record<string, unknown>; id?: string; signal?: AbortSignal } = {},
  ) {
    const id = options.id ?? crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      const room = await this.open(target);
      const keys = await this.#keys(attempt ? 'force' : false);
      const form = (await this.read(room.id, { after: seq - 1, limit: 1 })).messages[0];
      if (form?.seq !== seq || form.kind !== 'form') throw new HeraldError('No such form.', 404);
      const asker = keys.recipient(form.sender);
      if (!asker) throw new e2ee.E2eeError('The asker is not verified.');
      const seal = (input: e2ee.ChatSealInput) =>
        e2ee.sealChat(keys, room, input, this.#trust(room.id));
      const input = { id, text: '', kind: 'answer' as const, sub: form.sub };
      const body = {
        id,
        envelope: await seal({ ...input, audience: form.audience, answers }),
        headVersion: room.headVersion,
        ...(form.sub ? { sub: form.sub } : {}),
        ...(options.secrets
          ? {
              secrets: await seal({
                ...input,
                answers: options.secrets,
                to: [asker],
                ctxAudience: 'asker',
              }),
            }
          : {}),
      };
      try {
        const sent = await this.#request<{ seq: number; id: string; duplicate?: true }>(
          `${path(room.id)}/messages/${seq}/response`,
          body,
          { idempotencyKey: id, signal: options.signal },
        );
        return { ...sent, room: room.id };
      } catch (error) {
        if (attempt || !(error instanceof HeraldError) || error.code !== 'ROOM_STALE') throw error;
      }
    }
  }
  /** Encrypts and uploads a file for one later message in this room. */
  async attach(
    target: string,
    name: string,
    data: Uint8Array,
    type = 'application/octet-stream',
    options: { signal?: AbortSignal } = {},
  ): Promise<ChatAttachment> {
    const room = await this.open(target);
    const key = e2ee.fileKey();
    const { id } = await this.#request<{ id: string }>(`${path(room.id)}/files`, {
      size: e2ee.sealedSize(data.byteLength),
    });
    const response = await this.#raw(`${path(room.id)}/files/${id}`, {
      method: 'PUT',
      body: await new Response(e2ee.sealFile(key, data)).arrayBuffer(),
      signal: options.signal,
    });
    if (!response.ok) await readError(response, 'File upload failed.');
    await response.body?.cancel();
    return { id, name, type, size: data.byteLength, key };
  }
  /** Downloads and decrypts a message's attachment. */
  async download(
    target: string,
    file: ChatAttachment,
    options: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    const room = await this.open(target);
    const response = await this.#raw(`${path(room.id)}/files/${file.id}`, options);
    if (!response.ok) await readError(response, 'File download failed.');
    if (!response.body) throw new HeraldError('Herald returned no file body.', response.status);
    return new Uint8Array(await new Response(e2ee.openFile(file.key, response.body)).arrayBuffer());
  }
  /** Releases the wake up to `seq` and marks it read. */
  async ack(room: string, seq: number): Promise<{ readSeq: number }> {
    await this.#request(`${path(room)}/ack`, { seq });
    return this.#request(`${path(room)}/read`, { seq });
  }
  /** Leases a room's wake and reads what it covers; undefined when absent or already held. */
  async #take(room: string, ttl?: number): Promise<ChatWake | undefined> {
    let wake: Lease | null;
    try {
      ({ wake } = await this.#request<{ wake: Lease | null }>(
        `${path(room)}/lease`,
        ttl === undefined ? {} : { ttl },
      ));
    } catch (error) {
      if (error instanceof HeraldError && error.code === 'LEASED') return undefined;
      throw error;
    }
    if (!wake) return undefined;
    const seen: ChatMessage[] = [];
    for (let cursor = wake.contextFrom - 1; cursor < wake.seq;) {
      const page = await this.read(room, { after: cursor, limit: PAGE });
      seen.push(...page.messages);
      cursor = page.through_seq;
      if (!page.hasMore) break;
    }
    const usable = (m: ChatMessage) =>
      m.seq <= wake.seq && !m.locked && m.kind !== 'event' && m.kind !== 'tombstone';
    return {
      ...wake,
      messages: seen.filter((m) => usable(m) && m.seq >= wake.first && !m.mine),
      history: seen.filter((m) => usable(m) && m.seq < wake.first),
    };
  }
  /**
   * Waits for one wake in a room, leases and acknowledges it. Undefined when the timeout passes.
   * `lease` is how long, in seconds, a crashed caller holds the wake before it fires again.
   */
  async next(
    target: string,
    options: { timeout?: number; lease?: number; signal?: AbortSignal } = {},
  ): Promise<ChatWake | undefined> {
    const room = await this.open(target);
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, (options.timeout ?? 3600) * 1000);
    let found: ChatWake | undefined;
    let queue = Promise.resolve();
    const attempt = () => {
      queue = queue.then(async () => {
        if (found || stop.signal.aborted) return;
        found = await this.#take(room.id, options.lease).catch(() => undefined);
        if (!found) return;
        await this.ack(room.id, found.seq);
        stop.abort();
      });
    };
    try {
      attempt();
      await queue;
      if (found) return found;
      await this.#sockets(
        (frame) => {
          if (frame.type === 'wake' && frame.room === room.id) attempt();
        },
        attempt,
        stop.signal,
      );
      await queue;
      return found;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  /**
   * Runs `handler` once per coalesced wake under a lease, replaying pending wakes on connect. A
   * handler that throws is not acknowledged, so its wake fires again when the lease lapses.
   */
  wakes(
    handler: (wake: ChatWake) => void | Promise<void>,
    options: {
      signal?: AbortSignal;
      rooms?: string[];
      lease?: number;
      onError?: (error: unknown, room: string) => void;
    } = {},
  ): Promise<void> {
    const { signal } = options;
    const allowed = options.rooms && new Set(options.rooms);
    const queues = new Map<string, Promise<void>>();
    const drain = async (room: string) => {
      while (!signal?.aborted) {
        const wake = await this.#take(room, options.lease);
        if (!wake) return;
        if (wake.messages.length) await handler(wake);
        await this.ack(room, wake.seq);
      }
    };
    const enqueue = (room: unknown) => {
      if (typeof room !== 'string' || !ROOM_ID.test(room) || (allowed && !allowed.has(room)))
        return;
      queues.set(
        room,
        (queues.get(room) ?? Promise.resolve()).then(() =>
          drain(room).catch((error) => {
            if (!signal?.aborted) options.onError?.(error, room);
          }),
        ),
      );
    };
    const replay = () => {
      void this.#request<{ wakes: { room: string }[] }>('/chats/wakes').then(
        ({ wakes }) => wakes.forEach((w) => enqueue(w.room)),
        (error) => options.onError?.(error, ''),
      );
    };
    return this.#sockets(
      (frame) => {
        if (frame.type === 'wake') enqueue(frame.room);
      },
      replay,
      signal,
    ).then(() => Promise.allSettled(queues.values()).then(() => undefined));
  }
  /**
   * Waits for the next wake and returns its messages, or with `after` for anything from others
   * past that seq, acknowledged. Returns an empty list when the timeout passes.
   */
  async wait(
    target: string,
    options: { after?: number; timeout?: number; signal?: AbortSignal } = {},
  ): Promise<ChatMessage[]> {
    if (options.after === undefined) return (await this.next(target, options))?.messages ?? [];
    const room = await this.open(target);
    const after = options.after;
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, (options.timeout ?? 3600) * 1000);
    const found: ChatMessage[] = [];
    try {
      const drain = async () => {
        for (let cursor = after; ;) {
          const page = await this.read(room.id, { after: cursor, limit: PAGE });
          found.push(...page.messages.filter((m) => !m.mine && m.kind === 'message'));
          cursor = page.through_seq;
          if (!page.hasMore) break;
        }
      };
      await drain();
      if (found.length) {
        await this.ack(room.id, found.at(-1)!.seq);
        return found;
      }
      await this.#subscribe(
        (message) => {
          found.push(message);
          stop.abort();
        },
        { signal: stop.signal, rooms: [room.id], cursors: new Map([[room.id, after]]), ack: true },
      );
      return found;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  /** Delivers each new message from others, in order per room, until the signal aborts. */
  listen(
    handler: (message: ChatMessage) => void | Promise<void>,
    options: {
      signal?: AbortSignal;
      rooms?: string[];
      onError?: (error: unknown, room: string) => void;
    } = {},
  ): Promise<void> {
    return this.#subscribe(handler, { ...options, ack: true });
  }
  async #subscribe(
    handler: (message: ChatMessage) => void | Promise<void>,
    options: {
      signal?: AbortSignal;
      rooms?: string[];
      cursors?: Map<string, number>;
      ack: boolean;
      onError?: (error: unknown, room: string) => void;
    },
  ): Promise<void> {
    const { signal } = options;
    const cursors = options.cursors ?? new Map<string, number>();
    const allowed = options.rooms && new Set(options.rooms);
    const verified = new Set<string>();
    const queues = new Map<string, Promise<void>>();
    const tagged = new Map<string, string>();
    const deliver = async (message: ChatMessage) => {
      const tag = tagged.get(`${message.room}:${message.seq}`);
      if (tag) {
        tagged.delete(`${message.room}:${message.seq}`);
        message = { ...message, subagent: tag };
      }
      if (!message.mine && message.kind === 'message' && !message.locked) {
        await handler(message);
        if (options.ack) await this.ack(message.room, message.seq);
      }
      cursors.set(message.room, message.seq);
    };
    const prepare = async (room: string) => {
      if (verified.has(room) && cursors.has(room)) return;
      const view = await this.open(room);
      verified.add(room);
      if (!cursors.has(room)) cursors.set(room, view.readSeq);
    };
    const catchUp = async (room: string) => {
      for (;;) {
        const page = await this.read(room, { after: cursors.get(room)!, limit: PAGE });
        for (const message of page.messages) {
          if (signal?.aborted) return;
          await deliver(message);
        }
        if (!page.hasMore) return;
      }
    };
    const handle = async (frame: Frame) => {
      if (signal?.aborted || (frame.type !== 'message' && frame.type !== 'wake')) return;
      await prepare(frame.room);
      if (frame.seq <= cursors.get(frame.room)!) return;
      if (frame.type !== 'message' || frame.hint || frame.prev !== cursors.get(frame.room))
        return catchUp(frame.room);
      await deliver(await this.#open(frame.room, frame, await this.#keys()));
    };
    const enqueue = (frame: Frame) => {
      if (typeof frame?.room !== 'string' || !ROOM_ID.test(frame.room)) return;
      if (allowed && !allowed.has(frame.room)) return;
      if (typeof frame.subagent === 'string' && tagged.size < 1000)
        tagged.set(`${frame.room}:${frame.seq}`, frame.subagent);
      const previous = queues.get(frame.room) ?? Promise.resolve();
      queues.set(
        frame.room,
        previous.then(() =>
          handle(frame).catch((error) => {
            if (!signal?.aborted) options.onError?.(error, frame.room);
          }),
        ),
      );
    };
    await this.#sockets(enqueue as (frame: Socketed) => void, undefined, signal);
    await Promise.allSettled(queues.values());
  }
  /** Keeps one socket open until the signal aborts; `onOpen` runs on every connect. */
  async #sockets(
    onFrame: (frame: Socketed) => void,
    onOpen: (() => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (let attempt = 0; !signal?.aborted; attempt++) {
      await new Promise<void>((resolve) => {
        const socket = this.#connect();
        let alive = true;
        let ended = false;
        const finish = () => {
          if (ended) return;
          ended = true;
          clearInterval(ping);
          signal?.removeEventListener('abort', finish);
          try {
            socket.close();
          } catch {
            // Already closed.
          }
          resolve();
        };
        const ping = setInterval(() => {
          if (!alive) return finish();
          alive = false;
          socket.send('ping');
        }, KEEPALIVE);
        socket.on('open', () => {
          attempt = -1;
          onOpen?.();
        });
        socket.on('message', (data) => {
          const text = String(data);
          if (text === 'pong') return void (alive = true);
          try {
            onFrame(JSON.parse(text) as Socketed);
          } catch {
            // Not a frame this client understands.
          }
        });
        socket.on('close', finish);
        socket.on('error', finish);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
      await sleep(backoff(Math.max(attempt, 0)), signal).catch(() => {});
    }
  }
}
