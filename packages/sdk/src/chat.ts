import type { ChatKeys, ChatPayload, ChatRecord, ChatRoom } from './e2ee/index.js';
import * as e2ee from './e2ee/index.js';
import { HeraldError, sleep } from './http.js';
import type { KeyedSession } from './keyed.js';
import { backoff, KEEPALIVE, type EventSocket } from './socket.js';
export type { ChatRoom } from './e2ee/index.js';
/** An opened chat message; `locked` when it could not be decrypted or verified. */
export type ChatMessage = Omit<ChatRecord, 'envelope'> & {
  room: string;
  text: string;
  mine: boolean;
  locked?: boolean;
  /** The runtime subagent the sender tagged, when this connection owns it. */
  subagent?: string;
};
export type ChatPage = { messages: ChatMessage[]; through_seq: number; hasMore: boolean };
export type ChatSendOptions = {
  audience?: 'all' | 'humans';
  sub?: string;
  replyTo?: number;
  id?: string;
  signal?: AbortSignal;
};
type Request = <T>(
  path: string,
  body?: unknown,
  options?: { idempotencyKey?: string; signal?: AbortSignal },
) => Promise<T>;
type Frame =
  | (ChatRecord & { type: 'message'; room: string; prev: number; hint?: true; subagent?: string })
  | {
      type: 'wake' | 'read';
      room: string;
      seq: number;
      subagent?: string;
    };
const PAGE = 100;
const path = (room: string) => '/chats/' + encodeURIComponent(room);
const ROOM_ID = /^[\w-]{43}$/;
/** Decrypted chat for one connection: rooms are verified and every message is opened locally. */
export class ChatClient {
  #request: Request;
  #keyed: () => KeyedSession;
  #connect: () => EventSocket;
  constructor(request: Request, keyed: () => KeyedSession, connect: () => EventSocket) {
    this.#request = request;
    this.#keyed = keyed;
    this.#connect = connect;
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
        await e2ee.verifyChatRoom(keys, room).then(
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
  async #verified(room: ChatRoom): Promise<ChatRoom> {
    await e2ee.verifyChatRoom(await this.#keys(), room).catch(async () => {
      await e2ee.verifyChatRoom(await this.#keys('force'), room);
    });
    return room;
  }
  async #open(room: string, record: ChatRecord, keys: ChatKeys): Promise<ChatMessage> {
    const base: Omit<ChatRecord, 'envelope'> & { envelope?: unknown } = { ...record };
    delete base.envelope;
    const mine = record.sender === keys.principal;
    let payload: ChatPayload | undefined;
    for (const refresh of [false, true]) {
      try {
        payload = await e2ee.openChat(refresh ? await this.#keys(true) : keys, room, record);
        break;
      } catch {
        // A new connection's certificate may be newer than the cached directory.
      }
    }
    return payload
      ? { ...base, room, mine, text: payload.text }
      : { ...base, room, mine, text: '', locked: true };
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
  async send(target: string, text: string, options: ChatSendOptions = {}) {
    const id = options.id ?? crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      const room = await this.open(target);
      const keys = await this.#keys(attempt ? 'force' : false);
      const body = {
        id,
        envelope: await e2ee.sealChat(keys, room, { id, text, ...options }),
        headVersion: room.headVersion,
        ...(options.audience ? { audience: options.audience } : {}),
        ...(options.sub ? { sub: options.sub } : {}),
        ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
      };
      try {
        const sent = await this.#request<{ seq: number; id: string; duplicate?: true }>(
          `${path(room.id)}/messages`,
          body,
          { idempotencyKey: id, signal: options.signal },
        );
        return { ...sent, room: room.id };
      } catch (error) {
        if (attempt || !(error instanceof HeraldError) || error.code !== 'ROOM_STALE') throw error;
      }
    }
  }
  /** Marks everything up to `seq` read and releases the wake. */
  ack(room: string, seq: number): Promise<{ readSeq: number }> {
    return this.#request(`${path(room)}/read`, { seq });
  }
  /**
   * Waits for messages from others after `after` (default: the read cursor), acknowledges them
   * and returns them. Returns an empty list when the timeout passes.
   */
  async wait(
    target: string,
    options: { after?: number; timeout?: number; signal?: AbortSignal } = {},
  ): Promise<ChatMessage[]> {
    const room = await this.open(target);
    const after = options.after ?? room.readSeq;
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
      if (signal?.aborted || frame.type === 'read') return;
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
        socket.on('open', () => (attempt = -1));
        socket.on('message', (data) => {
          const text = String(data);
          if (text === 'pong') return void (alive = true);
          try {
            enqueue(JSON.parse(text) as Frame);
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
    await Promise.allSettled(queues.values());
  }
}
