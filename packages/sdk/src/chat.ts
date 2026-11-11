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
import { z } from 'zod';
import { messageInputSchema } from './schema/index.js';
import { HeraldError, readError, sleep } from './http.js';
import type { KeyedSession } from './keyed.js';
import { backoff, KEEPALIVE, type EventSocket } from './socket.js';
export type { AgentReach, ChatRoom, RoomAgent, RoomSubagent } from './e2ee/index.js';
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
  /** The sender's one-line stand-in while the message is collapsed. */
  summary?: string;
  /** The declared mentions differ from the signed ones, which `mentions` holds. */
  mentionsMismatch?: true;
  /** The subagent keys the sender addressed, as signed. */
  tags?: string[];
  /** The sender's display names for `sub` and `tags` keys; malformed entries are dropped. */
  names?: Record<string, string>;
};
/** A room in a listing, with its title opened. */
export type ChatListing = Pick<ChatRoom, 'id' | 'kind' | 'unread' | 'lastSeq' | 'members'> & {
  title?: string;
};
export type WakeReason = 'form_answer' | 'mention' | 'reply' | 'message';
/** One handled batch: new `messages` from others, and earlier `history` per the context mode. */
export type ChatWake = {
  room: string;
  first: number;
  seq: number;
  reason: WakeReason;
  /** The runtime subagent a message tagged, when this connection owns it. */
  subagent?: string;
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
  /** Subagent keys this message addresses; their connection's wake names one. */
  tags?: string[];
  /** A one-line stand-in, max 200 chars, shown while the message is collapsed. */
  summary?: string;
  /**
   * Display names (1 to 60 chars) for the `sub` and `tags` keys, sealed with the message so
   * readers can show them after the agents are gone. Filled from the profiles this client
   * registered with `agents.register`; entries here win. Other keys are dropped.
   */
  names?: Record<string, string>;
};
const validName = (name: unknown): name is string =>
  typeof name === 'string' && !!name.trim() && name.length <= 60;
/** The `names` entries for `keys` that are well formed. */
export const chatNames = (names: unknown, keys: Iterable<string>) => {
  const out: Record<string, string> = {};
  if (!names || typeof names !== 'object') return out;
  for (const key of keys) {
    const name = Object.hasOwn(names, key) ? (names as Record<string, unknown>)[key] : undefined;
    if (e2ee.subagentKey.test(key) && validName(name)) out[key] = name;
  }
  return out;
};
export type ChatReadOptions = {
  after?: number;
  before?: number;
  limit?: number;
  signal?: AbortSignal;
  /** Read as this subagent of the connection: one people cannot reach sees no human messages. */
  for?: string;
};
export type ChatGroupOptions = {
  /** Default: the creator, plus every person when an agent creates it. */
  owners?: string[];
  team?: string;
  /** Agent turns in a row, between different agents, before wakes pause until a person writes (1 to 1000, default 6). */
  hopLimit?: number;
  /** Titles the room after creating it. */
  title?: string;
};
export type ChatFormRules = { deadline?: number; answerers?: 'humans' | 'any' };
type ChatRequest = <T>(
  path: string,
  body?: unknown,
  options?: { idempotencyKey?: string; signal?: AbortSignal; method?: string },
) => Promise<T>;
type Raw = (path: string, init: RequestInit) => Promise<Response>;
type Lease = Omit<ChatWake, 'messages' | 'history'>;
/** What a kind of message adds to the sealed payload and to the cleartext body. */
type Posted = {
  kind?: 'message' | 'title' | 'form' | 'event';
  event?: ChatEvent;
  form?: Record<string, unknown>;
  rules?: ChatFormRules;
};
type Frame =
  | (ChatRecord & { type: 'message'; room: string; prev: number; hint?: true })
  | {
      type: 'wake' | 'read';
      room: string;
      seq: number;
      subagent?: string;
    };
type Socketed = { type?: string; room?: string; subagent?: string };
const fromOthers = (m: ChatMessage) => !m.mine && m.kind === 'message' && !m.locked;
const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const RECENT = 20;
const PAGE = 100;
const path = (room: string) => '/chats/' + encodeURIComponent(room);
const ROOM_ID = /^[\w-]{43}$/;
/** Decrypted chat for one connection: rooms are verified and every message is opened locally. */
export class ChatClient {
  #request: ChatRequest;
  #keyed: () => KeyedSession;
  #connect: () => EventSocket;
  #raw: Raw;
  #names: (key: string) => string | undefined;
  #left: (room: string, key: string) => void;
  /** Newest head verified per group, so the server cannot roll one back during this process. */
  #pins = new Map<string, { version: number; hash: string }>();
  #heads = new Map<string, ReadonlyMap<string, string[]> | null>();
  #recent = new Map<string, Set<string>>();
  constructor(
    request: ChatRequest,
    keyed: () => KeyedSession,
    connect: () => EventSocket,
    raw: Raw,
    names: (key: string) => string | undefined = () => undefined,
    left: (room: string, key: string) => void = () => {},
  ) {
    this.#request = request;
    this.#keyed = keyed;
    this.#connect = connect;
    this.#raw = raw;
    this.#names = names;
    this.#left = left;
  }
  /** Sealed names for `keys`: explicit ones first, then the profiles this client set. */
  #sealedNames(keys: (string | undefined)[], explicit: Record<string, string> = {}) {
    const wanted = [...new Set(keys.filter((k): k is string => !!k))];
    for (const key of wanted)
      if (Object.hasOwn(explicit, key) && !validName(explicit[key]))
        throw new HeraldError(`The name for ${key} must be 1 to 60 characters.`, 400);
    const known = Object.fromEntries(
      wanted.flatMap((k) => (this.#names(k) ? [[k, this.#names(k)]] : [])),
    );
    const names = chatNames({ ...known, ...explicit }, wanted);
    return Object.keys(names).length ? names : undefined;
  }
  #policy?: { at: number; value: Promise<e2ee.SignedChatPolicy | null> };
  #claim = 0;
  /** Keys plus, for a team, the signed chat policy, refetched as often as the directory. */
  #keys = async (refresh: boolean | 'force' = false): Promise<ChatKeys> => {
    const keyed = this.#keyed();
    if (!(await keyed.state(refresh)).ws) return keyed.chatKeys();
    const age = this.#policy ? Date.now() - this.#policy.at : Infinity;
    // A member signed a newer version: refetch once, and ignore it if it still does not verify.
    const claim = keyed.policyClaim > this.#claim ? (this.#claim = keyed.policyClaim) : 0;
    if (!this.#policy || refresh === 'force' || claim || (refresh && age > 10_000))
      this.#policy = {
        at: Date.now(),
        value: this.#request<{ policy: e2ee.SignedChatPolicy | null }>('/chats/policy').then(
          (r) => r.policy,
          () => null,
        ),
      };
    return keyed.chatKeys(false, await this.#policy!.value);
  };
  /** Rooms the connection can verify, newest first; others are left out. */
  async list(options: { before?: number; limit?: number } = {}): Promise<ChatListing[]> {
    const query = new URLSearchParams();
    if (options.before !== undefined) query.set('before', String(options.before));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const q = query.size ? '?' + query : '';
    const { rooms } = await this.#request<{ rooms: ChatRoom[] }>('/chats' + q);
    const keys = await this.#keys(true);
    const out: ChatListing[] = [];
    for (const room of rooms) {
      const ok = await e2ee.verifyChatRoom(keys, room, this.#trust(room.id)).then(
        () => true,
        () => false,
      );
      if (!ok) continue;
      const { id, kind, unread, lastSeq, members } = room;
      // A title needs only the verified chain; reading it costs no request per room.
      const heads = room.kind === 'group' ? { heads: await e2ee.roomHeads(room) } : {};
      const title =
        room.title && (await e2ee.openChat(keys, id, room.title, heads).catch(() => undefined));
      out.push({ id, kind, title: title?.text || undefined, unread, lastSeq, members });
    }
    return out;
  }
  /**
   * The room for an id, or the DM with `h:…`, `a:…` or `owner`, created if needed. `agent` opens
   * the DM with one agent of that connection (or of this one, with `owner`) instead.
   */
  async open(target: string, options: { agent?: string } = {}): Promise<ChatRoom> {
    const room = ROOM_ID.test(target)
      ? await this.#request<ChatRoom>(path(target))
      : await this.#request<ChatRoom>('/chats', {
          kind: 'dm',
          with: target,
          ...(options.agent ? { agent: options.agent } : {}),
        });
    return this.#verified(room);
  }
  /** Adds one of this connection's registered agents to a room it is in, or changes its settings. */
  async addAgent(
    room: string,
    key: string,
    options: { notify?: e2ee.NotifyRule; context?: e2ee.ContextMode } = {},
  ): Promise<ChatRoom> {
    return this.#verified(
      await this.#request<ChatRoom>(`${path(room)}/agents/${encodeURIComponent(key)}`, options, {
        method: 'PUT',
      }),
    );
  }
  /** Removes one of this connection's agents from a room; its pending wakes there go too. */
  async removeAgent(room: string, key: string): Promise<ChatRoom> {
    const left = await this.#request<ChatRoom>(
      `${path(room)}/agents/${encodeURIComponent(key)}`,
      undefined,
      { method: 'DELETE' },
    );
    this.#left(room, key);
    return this.#verified(left);
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
    const named = await e2ee.roomHeads(room);
    const heads = new Set<string>();
    for (const record of page.messages) {
      if (!record.envelope) continue;
      const head = String(record.envelope.ctx.head);
      if (!e2ee.vouches(named, head, record.sender)) continue;
      const opened = await e2ee.openChat(keys, room.id, record).then(
        () => true,
        () => false,
      );
      if (opened) heads.add(head);
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
    const tags = Array.isArray(payload.tags)
      ? payload.tags.filter((t) => typeof t === 'string')
      : undefined;
    const summary = typeof payload.summary === 'string' ? payload.summary.slice(0, 200) : undefined;
    const names = chatNames(payload.names, Object.keys(payload.names ?? {}));
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
        summary,
        mentions,
        mentionsMismatch,
        tags: tags?.length ? tags : undefined,
        names: Object.keys(names).length ? names : undefined,
        secrets: sealed?.answers as Record<string, unknown> | undefined,
      }),
    };
  }
  /** One page, oldest first; pass `after` to read forward and `before` to read back. */
  async read(room: string, options: ChatReadOptions = {}): Promise<ChatPage> {
    const query = new URLSearchParams();
    if (options.for) query.set('for', options.for);
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
  async ask(
    target: string,
    form: Record<string, unknown>,
    options: ChatSendOptions & ChatFormRules = {},
  ) {
    // The same schema the Inbox applies; an invalid form would only show as unverifiable.
    const parsed = messageInputSchema.safeParse({ ...form, kind: 'form' });
    if (!parsed.success) throw new HeraldError(z.prettifyError(parsed.error), 400);
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
  /** A new group; an agent may add other agents and the people it already chats with. */
  async group(members: string[], options: ChatGroupOptions = {}): Promise<ChatRoom> {
    const keys = await this.#keys();
    const me = keys.principal;
    const nonce = e2ee.b64u.encode(crypto.getRandomValues(new Uint8Array(16)));
    const all = [me, ...new Set(members.filter((m) => m !== me))];
    const owners =
      options.owners ??
      (me.startsWith('a:') ? all.filter((p) => p === me || p.startsWith('h:')) : [me]);
    const head: e2ee.ChatHead = {
      room: await e2ee.groupRoomId(me, nonce),
      version: 1,
      prev: '',
      owners,
      members: all,
      ...(options.team ? { team: options.team } : {}),
    };
    const signed = await e2ee.signChatHead({ ...keys, principal: me }, head);
    const body = { kind: 'group', nonce, head: signed, ...defined({ hopLimit: options.hopLimit }) };
    const room = await this.#verified(await this.#request<ChatRoom>('/chats', body));
    if (!options.title) return room;
    await this.title(room.id, options.title);
    return this.open(room.id);
  }
  /** Sets the room's title; any member may. */
  title(target: string, text: string) {
    return this.#post(target, text, {}, { kind: 'title' });
  }
  /** Signs the next head; an agent owner may add or remove agents only. */
  async updateGroup(
    target: string,
    change: { add?: string[]; remove?: string[]; owners?: string[] },
  ): Promise<ChatRoom> {
    const room = await this.open(target);
    const tip =
      room.chain?.at(-1)?.head ??
      (() => {
        throw new HeraldError('Only groups have members to change.', 400);
      })();
    const gone = new Set(change.remove ?? []);
    const members = [
      ...tip.members.filter((m) => !gone.has(m)),
      ...new Set((change.add ?? []).filter((m) => !tip.members.includes(m))),
    ];
    const head: e2ee.ChatHead = {
      ...tip,
      version: tip.version + 1,
      prev: await e2ee.headHash(tip),
      members,
      owners: change.owners ?? tip.owners.filter((o) => members.includes(o)),
    };
    const keys = await this.#keys();
    const signed = await e2ee.signChatHead(keys, head);
    return this.#verified(await this.#request<ChatRoom>(`${path(room.id)}/heads`, signed));
  }
  async #post(target: string, text: string, options: ChatSendOptions, extra: Posted = {}) {
    const id = options.id ?? crypto.randomUUID();
    const { audience, sub, replyTo, mentions, attachments, reference, signal, tags, summary } =
      options;
    if (summary !== undefined && summary.length > 200)
      throw new HeraldError('A summary is at most 200 characters.', 400);
    const names = this.#sealedNames([sub, ...(tags ?? [])], options.names);
    const { kind, event, form, rules } = extra;
    for (let attempt = 0; ; attempt++) {
      const room = await this.open(target);
      const keys = await this.#keys(attempt ? 'force' : false);
      const input = {
        id,
        text,
        ...defined({ kind, audience, sub, mentions, attachments, reference, event, form, summary }),
        ...(tags?.length ? { tags } : {}),
        ...defined({ names }),
      };
      const body = {
        id,
        envelope: await e2ee.sealChat(keys, room, input, this.#trust(room.id)),
        headVersion: room.headVersion,
        ...defined({ audience, replyTo, kind, mentions }),
        ...(sub ? { sub } : {}),
        ...(tags?.length ? { tags } : {}),
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
      const names = this.#sealedNames([form.sub]);
      const input = { id, text: '', kind: 'answer' as const, sub: form.sub, ...defined({ names }) };
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
  /**
   * Releases the wake up to `seq` and marks it read. A room keeps one wake per subagent: `subagent`
   * ('' for the connection) releases only that one, and a subagent's ack leaves the read mark alone.
   */
  ack(room: string, seq: number, subagent?: string): Promise<{ readSeq?: number }> {
    return this.#request(`${path(room)}/ack`, subagent === undefined ? { seq } : { seq, subagent });
  }
  /** Leases a room's wake and reads what it covers; undefined when absent or already held. */
  async #take(room: string, ttl?: number, subagent?: string): Promise<ChatWake | undefined> {
    let wake: Lease | null;
    try {
      ({ wake } = await this.#request<{ wake: Lease | null }>(`${path(room)}/lease`, {
        ...(ttl === undefined ? {} : { ttl }),
        ...(subagent === undefined ? {} : { subagent }),
      }));
    } catch (error) {
      if (error instanceof HeraldError && error.code === 'LEASED') return undefined;
      throw error;
    }
    if (!wake) return undefined;
    const seen: ChatMessage[] = [];
    for (let cursor = wake.contextFrom - 1; cursor < wake.seq;) {
      const page = await this.read(room, { after: cursor, limit: PAGE, for: wake.subagent });
      seen.push(...page.messages);
      cursor = page.through_seq;
      if (!page.hasMore) break;
    }
    const usable = (m: ChatMessage) =>
      m.seq <= wake.seq && !m.locked && m.kind !== 'event' && m.kind !== 'tombstone';
    return {
      ...wake,
      // A sibling subagent's message is new to the one woken; only its own are not.
      messages: seen.filter(
        (m) => usable(m) && m.seq >= wake.first && !(m.mine && m.sub === (wake.subagent ?? '')),
      ),
      history: seen.filter((m) => usable(m) && m.seq < wake.first),
    };
  }
  /**
   * Waits for one wake in a room, the oldest of the connection or any of its subagents, leases and
   * acknowledges it. Undefined when the timeout passes.
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
    let failure: unknown;
    let queue = Promise.resolve();
    const attempt = () => {
      queue = queue
        .then(async () => {
          if (found || stop.signal.aborted) return;
          found = await this.#take(room.id, options.lease);
          if (!found) return;
          await this.ack(room.id, found.seq, found.subagent ?? '');
          stop.abort();
        })
        .catch((error) => {
          failure = error;
          stop.abort();
        });
    };
    try {
      attempt();
      await queue;
      if (failure) throw failure;
      if (found) return found;
      await this.#sockets(
        (frame) => {
          if (frame.type === 'wake' && frame.room === room.id) attempt();
        },
        attempt,
        stop.signal,
      );
      await queue;
      if (failure) throw failure;
      return found;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  /**
   * Runs `handler` once per coalesced wake under a lease, replaying pending wakes on connect; each
   * room keeps one wake per subagent. A handler that throws is not acknowledged, so its wake fires
   * again when the lease lapses.
   */
  wakes(
    handler: (wake: ChatWake) => void | Promise<void>,
    options: {
      signal?: AbortSignal;
      rooms?: string[];
      lease?: number;
      onError?: (error: unknown, room?: string) => void;
    } = {},
  ): Promise<void> {
    const { signal } = options;
    const allowed = options.rooms && new Set(options.rooms);
    const queues = new Map<string, Promise<void>>();
    const drain = async (room: string, subagent: string) => {
      while (!signal?.aborted) {
        const wake = await this.#take(room, options.lease, subagent);
        if (!wake) return;
        if (wake.messages.length) await handler(wake);
        await this.ack(room, wake.seq, subagent);
      }
    };
    const enqueue = (room: unknown, subagent: unknown) => {
      if (typeof room !== 'string' || !ROOM_ID.test(room) || (allowed && !allowed.has(room)))
        return;
      const sub = typeof subagent === 'string' ? subagent : '';
      const key = `${room} ${sub}`;
      queues.set(
        key,
        (queues.get(key) ?? Promise.resolve()).then(() =>
          drain(room, sub).catch((error) => {
            if (!signal?.aborted) options.onError?.(error, room);
          }),
        ),
      );
    };
    const replay = () => {
      void this.#request<{ wakes: { room: string; subagent?: string }[] }>('/chats/wakes').then(
        ({ wakes }) => wakes.forEach((w) => enqueue(w.room, w.subagent)),
        (error) => options.onError?.(error),
      );
    };
    return this.#sockets(
      (frame) => {
        if (frame.type === 'wake') enqueue(frame.room, frame.subagent);
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
          found.push(...page.messages.filter(fromOthers));
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
    const deliver = async (message: ChatMessage) => {
      if (fromOthers(message)) {
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
    // A reconnect reads back what arrived while the socket was down.
    const resume = () =>
      cursors.forEach((seq, room) => enqueue({ type: 'wake', room, seq: seq + 1 }));
    await this.#sockets(enqueue as (frame: Socketed) => void, resume, signal);
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
        let opened = false;
        const ping = setInterval(() => {
          // A socket not open by the next keepalive is stuck: retry instead of sending.
          if (!alive || !opened) return finish();
          alive = false;
          socket.send('ping');
        }, KEEPALIVE);
        socket.on('open', () => {
          opened = true;
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
