import type {
  ChatAttachment,
  ChatEvent,
  ChatForward,
  ChatKeys,
  ChatRecord,
  ChatRoom,
  OpenedChat,
  RoomTrust,
} from './e2ee/index.js';
import * as e2ee from './e2ee/index.js';
import { z } from 'zod';
import { chatFileLimits, fileTypeOf, limits, messageInputSchema } from './schema/index.js';
import { shrinkImage, type ChatFile } from './images.js';
import { HeraldError, readError, sleep } from './http.js';
import type { KeyedSession } from './keyed.js';
import { backoff, KEEPALIVE, type EventSocket } from './socket.js';
export type { AgentReach, ChatForward, ChatRoom, RoomAgent } from './e2ee/index.js';
/** An opened chat message; `locked` when it could not be decrypted or verified. */
export type ChatMessage = Omit<ChatRecord, 'envelope' | 'secrets' | 'event' | 'formState'> & {
  room: string;
  /** A form's state; a `closed` one carries the asker's `reason` when readable. */
  formState?: ChatFormState;
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
  /** A message in another room, shown here; dropped when malformed. Read it there with your own access. */
  forward?: ChatForward;
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
  status?: ChatRoomStatus;
};
/** A group's status: `idle`, `working`, `blocked` or `error`. No status at all is `null`. */
export type ChatStatus = { state: Exclude<e2ee.PresenceState, 'offline' | 'busy'>; text?: string };
/** What `setStatus` takes: `busy` is the old name of `working`; `offline` is not a room state. */
export type ChatStatusInput = {
  state: Exclude<e2ee.PresenceState, 'offline'>;
  /** A short note, up to 120 characters. */
  text?: string;
};
/** A room's opened status, with who set it and when (ms). */
export type ChatRoomStatus = ChatStatus & { by: string; at: number };
/** An opened pinned message: `sub` is the agent that pinned it ('' for a person or connection). */
export type ChatPin = {
  key: string;
  sender: string;
  sub: string;
  text: string;
  at: number;
  pinnedAt: number;
};
/** A pin set, replaced or (`pin: null`) cleared or no longer readable. */
export type ChatPinEvent = {
  room: string;
  sender: string;
  sub: string;
  key: string;
  pin: ChatPin | null;
};
export type ChatPinOptions = { sub?: string; signal?: AbortSignal };
/**
 * A form's state. `closed`: its asker withdrew it; `reason` is their note, absent when none was
 * given or this client cannot open it. Treat any other status as not answerable.
 */
export type ChatFormState = {
  status: 'open' | 'answered' | 'expired' | 'closed';
  by?: string;
  answer?: number;
  reason?: string;
};
/** A form's state changed, as the `form` frame says. */
export type ChatFormEvent = ChatFormState & { room: string; seq: number };
export type ChatCloseOptions = { reason?: string; sub?: string; signal?: AbortSignal };
/** `sub` resolves a person or `owner` target to that agent's DM, like the other calls. */
export type ChatRoomOptions = { sub?: string };
type PinWaiter = {
  text: string | null;
  resolve: (done: unknown) => void;
  reject: (error: unknown) => void;
};
type PinJob = { clear: boolean; waiters: PinWaiter[]; abort: AbortController };
type PinSlot = { tail: Promise<unknown>; jobs: number; queued?: PinJob };
const PIN_KEY = /^[\w.-]{1,64}$/;
const PIN_TEXT = 16_000; // chars; the server's PIN_BYTES fits it as CJK sealed to 64 members
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
/** A person asked the agent `subagent` of this connection to stop its current work in `room`. */
export type ChatStop = { room: string; subagent: string; by: string };
/**
 * A room this connection is in was archived or restored (`archivedAt`, ms; `null` once
 * restored), deleted, or its status changed (`null` once cleared).
 */
export type ChatRoomEvent =
  | { room: string; archivedAt: number | null }
  | { room: string; deleted: true }
  | { room: string; status: ChatRoomStatus | null };
export type ChatPage = { messages: ChatMessage[]; through_seq: number; hasMore: boolean };
export type ChatSendOptions = {
  audience?: 'all' | 'humans';
  /** The agent of this connection that speaks. Required to send to a person or `owner`, which opens that agent's DM. */
  sub?: string;
  replyTo?: number;
  id?: string;
  signal?: AbortSignal;
  mentions?: string[];
  attachments?: ChatAttachment[];
  /**
   * Files to encrypt, upload and attach: local paths (Node) or `{ name, data, type? }`, the type
   * from the name when absent. With `attachments`, at most `chatFileLimits.count` (10). Images
   * are shrunk first when the optional `sharp` package is installed (see `shrinkImage`).
   */
  files?: (string | ChatFileInput)[];
  /** A quoted snapshot of an Inbox request, sealed with the message. */
  reference?: Record<string, unknown>;
  /** Shows a message of another room (`room` id, `seq`); only its address is sealed. */
  forward?: ChatForward;
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
export type ChatFileInput = { name: string; data: Uint8Array; type?: string };
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
  /**
   * Read as this subagent of the connection: one people cannot reach sees no human messages. It
   * also names the agent whose DM a person or `owner` target opens.
   */
  for?: string;
};
/** A room agent: a string is one of this connection's own keys, an object another connection's. */
export type ChatGroupAgent = string | { connection: string; key: string; notify?: e2ee.NotifyRule };
export type ChatGroupOptions = {
  /** At least one agent for each connection in the group, this one included. */
  agents: ChatGroupAgent[];
  /** Default: the creator, plus every person when an agent creates it. */
  owners?: string[];
  team?: string;
  /** Agent turns in a row, between different agents, before wakes pause until a person writes (1 to 1000, default 6). */
  hopLimit?: number;
  /** Titles the room after creating it. */
  title?: string;
  /** Starts the room muted for its creator, or for this connection's owner; they can unmute. */
  muted?: boolean;
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
type Socketed = {
  type?: string;
  room?: string;
  subagent?: string;
  by?: string;
  archivedAt?: number | null;
  status?: unknown;
  sender?: unknown;
  sub?: unknown;
  key?: unknown;
  pin?: unknown;
  seq?: unknown;
  state?: unknown;
};
/** `work`, or the signal's reason as soon as it aborts. */
const abortable = <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> =>
  !signal
    ? work
    : new Promise<T>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
const fromOthers = (m: ChatMessage) => !m.mine && m.kind === 'message' && !m.locked;
const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const STATUS_STATES = new Set(['idle', 'working', 'busy', 'blocked', 'error']);
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
  #pinning = new Map<string, PinSlot>();
  #pinTurns = new Map<string, Promise<void>>();
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
      const status =
        room.status && (await this.#status(id, room.status, heads.heads).catch(() => undefined));
      out.push({
        id,
        kind,
        title: title?.text || undefined,
        unread,
        lastSeq,
        members,
        ...(status ? { status } : {}),
      });
    }
    return out;
  }
  /** The room for an id. */
  open(room: string): Promise<ChatRoom>;
  /**
   * The DM with `h:…`, `a:…` or `owner`, created if needed. `agent` is required: it names the
   * agent the DM is with (one of this connection's with `h:…` or `owner`, one of that connection's
   * with `a:…`). `muted` starts a new DM muted for its owner.
   */
  open(target: string, options: { agent: string; muted?: boolean }): Promise<ChatRoom>;
  async open(target: string, options: { agent?: string; muted?: boolean } = {}): Promise<ChatRoom> {
    return this.#openRoom(target, options.agent, undefined, options.muted);
  }
  async #openRoom(
    target: string,
    agent?: string,
    signal?: AbortSignal,
    muted?: boolean,
  ): Promise<ChatRoom> {
    const options = { agent };
    if (!ROOM_ID.test(target) && !options.agent)
      throw new HeraldError(
        'A chat with a person or connection names one of its agents.',
        400,
        undefined,
        undefined,
        'AGENT_REQUIRED',
      );
    const room = ROOM_ID.test(target)
      ? await this.#request<ChatRoom>(path(target), undefined, { signal })
      : await this.#request<ChatRoom>(
          '/chats',
          { kind: 'dm', with: target, agent: options.agent, ...defined({ muted }) },
          { signal },
        );
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
  /**
   * Archives a room: it turns read-only (writes fail with code `CHAT_ARCHIVED`), its pending
   * wakes end and its open forms close. A member connection may; so may a person who manages it.
   */
  async archive(room: string): Promise<ChatRoom> {
    return this.#archived(room, true);
  }
  /** Makes an archived room writable again; forms closed by archiving stay closed. */
  async unarchive(room: string): Promise<ChatRoom> {
    return this.#archived(room, false);
  }
  async #archived(room: string, archived: boolean): Promise<ChatRoom> {
    return this.#verified(
      await this.#request<ChatRoom>(`${path(room)}/archived`, { archived }, { method: 'PUT' }),
    );
  }
  #forget(room: string) {
    this.#pins.delete(room);
    this.#heads.delete(room);
    this.#recent.delete(room);
  }
  /** Deletes a room and its messages for good. A connection may delete only groups it created. */
  async deleteRoom(room: string): Promise<void> {
    try {
      await this.#request(path(room), undefined, { method: 'DELETE' });
    } catch (error) {
      if (error instanceof HeraldError && error.status === 404) this.#forget(room);
      throw error;
    }
    this.#forget(room);
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
    delete base.formState;
    const mine = record.sender === keys.principal;
    const out = { ...base, room, mine, text: '' } as ChatMessage;
    if (record.formState)
      out.formState = await this.#formState(
        room,
        record.seq,
        record.formState,
        record.sender,
        record.audience,
      );
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
    const forward = e2ee.chatForward(payload.forward);
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
        forward,
        summary,
        mentions,
        mentionsMismatch,
        tags: tags?.length ? tags : undefined,
        names: Object.keys(names).length ? names : undefined,
        secrets: sealed?.answers as Record<string, unknown> | undefined,
      }),
    };
  }
  /**
   * One page, oldest first; pass `after` to read forward and `before` to read back. A person or
   * `owner` target reads the DM of `for`, which it then needs.
   */
  async read(target: string, options: ChatReadOptions = {}): Promise<ChatPage> {
    const room = ROOM_ID.test(target) ? target : (await this.#dm(target, options.for, 'for')).id;
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
  /** `sub`: the agent of this connection that reacts. */
  react(
    target: string,
    seq: number,
    emoji: string,
    { remove, sub }: { remove?: boolean; sub?: string } = {},
  ) {
    const event: ChatEvent = {
      type: 'reaction',
      target: seq,
      emoji,
      ...(remove ? { remove: true } : {}),
    };
    return this.#post(target, '', { sub }, { kind: 'event', event });
  }
  /** Replaces a message's text; only its sender's edit counts. */
  edit(target: string, seq: number, text: string, options: { sub?: string } = {}) {
    return this.#post(target, text, options, {
      kind: 'event',
      event: { type: 'edit', target: seq },
    });
  }
  /**
   * A form's state with its sealed close reason opened; the reason is dropped when it cannot be
   * opened, is not signed by the asker, or names another form. The reason is sealed to the form's
   * `audience`.
   */
  async #formState(
    room: string,
    seq: number,
    state: e2ee.FormState,
    asker: string,
    audience: 'all' | 'humans' = 'all',
  ): Promise<ChatFormState> {
    const { status, by, answer, close } = state;
    const out: ChatFormState = { status, ...defined({ by, answer }) };
    if (status !== 'closed' || !close?.envelope || !by || by !== asker) return out;
    const record: e2ee.ChatCloseRecord = {
      seq: 0,
      id: close.id,
      sender: asker,
      sub: close.sub,
      at: close.at,
      kind: 'close',
      audience,
      envelope: close.envelope,
    };
    for (const refresh of [false, true]) {
      try {
        const keys = await this.#keys(refresh);
        const heads = await this.#headsOf(room, refresh);
        const opened = await e2ee.openChat(keys, room, record, heads ? { heads } : {});
        if (opened.close?.seq !== seq) return out;
        return opened.text.length <= 120 && opened.text ? { ...out, reason: opened.text } : out;
      } catch {
        // A membership or group head change may be newer than the cached view.
      }
    }
    return out;
  }
  /**
   * Closes your open form at `seq`: its asker withdraws it, so nobody can answer. `reason` (up to
   * 120 characters) is sealed to the room. Closing a closed form changes nothing; an answered,
   * expired or past-deadline one cannot be closed (`FORM_CLOSED`). Only the asker's connection may
   * close it (`NOT_ASKER`): any of its agents can, not just the one that asked. A person or `owner`
   * target needs `sub`.
   */
  async close(target: string, seq: number, options: ChatCloseOptions = {}): Promise<ChatFormState> {
    const { reason, sub, signal } = options;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 120))
      throw new HeraldError('A close reason is at most 120 characters.', 400);
    const room = await this.#dm(target, sub);
    const route = `${path(room.id)}/messages/${seq}/close`;
    if (!reason) {
      const done = await this.#request<{ state: e2ee.FormState }>(route, defined({ sub }), {
        signal,
      });
      return this.#formState(room.id, seq, done.state, done.state.by ?? '');
    }
    const id = crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      const view = attempt ? await this.open(room.id) : room;
      const keys = await this.#keys(attempt ? 'force' : false);
      const envelope = await e2ee.sealChat(
        keys,
        view,
        { id, text: reason, kind: 'close', sub: sub ?? '', close: { seq } },
        this.#trust(view.id),
      );
      try {
        const done = await this.#request<{ state: e2ee.FormState }>(
          route,
          { id, envelope, headVersion: view.headVersion, ...defined({ sub }) },
          { signal },
        );
        return this.#formState(room.id, seq, done.state, keys.principal);
      } catch (error) {
        if (attempt || !(error instanceof HeraldError) || error.code !== 'ROOM_STALE') throw error;
      }
    }
  }
  /** Removes a message's content, leaving a tombstone. A person or `owner` target needs `sub`. */
  async delete(target: string, seq: number, options: { sub?: string } = {}): Promise<void> {
    const room = await this.#dm(target, options.sub);
    await this.#request(`${path(room.id)}/messages/${seq}`, undefined, { method: 'DELETE' });
  }
  /**
   * A new group; an agent may add other agents and the people it already chats with. A connection
   * takes part through the agents in `options.agents`.
   */
  async group(members: string[], options: ChatGroupOptions): Promise<ChatRoom> {
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
    const agents = options.agents.map((a) =>
      typeof a === 'string' ? { connection: me, key: a } : defined(a),
    );
    const body = {
      kind: 'group',
      nonce,
      head: signed,
      agents,
      ...defined({ hopLimit: options.hopLimit, muted: options.muted }),
    };
    const room = await this.#verified(await this.#request<ChatRoom>('/chats', body));
    if (!options.title) return room;
    // A connection titles as its own first agent; a person needs none.
    const sub = options.agents.find((a) => typeof a === 'string' || a.connection === me);
    await this.title(room.id, options.title, {
      sub: typeof sub === 'string' ? sub : sub?.key,
    });
    return this.open(room.id);
  }
  /** Sets the room's title; any member may. A connection passes `sub`, one of its agents. */
  title(target: string, text: string, options: { sub?: string } = {}) {
    return this.#post(target, text, options, { kind: 'title' });
  }
  /**
   * Sets the room's status, or clears it with `null`; any member may. One per room: it replaces
   * the last, sends no message and counts as nothing unread. Members see it in `list()`,
   * `status()` and `onRoom`.
   */
  async setStatus(
    room: string,
    status: ChatStatusInput | null,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const { signal } = options;
    if (status === null) {
      await this.#request(`${path(room)}/status`, undefined, { method: 'DELETE', signal });
      return;
    }
    const { text } = status;
    const state = status.state === 'busy' ? 'working' : status.state;
    if (!e2ee.presenceStates.includes(state) || (state as string) === 'offline')
      throw new HeraldError('A room status is idle, working, blocked or error.', 400);
    if (text !== undefined && (typeof text !== 'string' || text.length > 120))
      throw new HeraldError('A status text is at most 120 characters.', 400);
    const id = crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      const view = await this.open(room);
      const keys = await this.#keys(attempt ? 'force' : false);
      const envelope = await e2ee.sealChat(
        keys,
        view,
        { id, text: '', kind: 'status', status: { state, ...defined({ text }) } },
        this.#trust(view.id),
      );
      try {
        await this.#request(
          `${path(view.id)}/status`,
          { id, envelope, headVersion: view.headVersion },
          { method: 'PUT', signal },
        );
        return;
      } catch (error) {
        if (attempt || !(error instanceof HeraldError) || error.code !== 'ROOM_STALE') throw error;
      }
    }
  }
  /** The room's status, or `undefined` when none is set or this client cannot open it. */
  async status(room: string): Promise<ChatRoomStatus | undefined> {
    const view = await this.open(room);
    return view.status ? this.#status(view.id, view.status).catch(() => undefined) : undefined;
  }
  /**
   * Opens a status record, refreshing keys and heads once like a message. A record that names an
   * unknown state gives `undefined`; one that still fails to open throws.
   */
  async #status(
    room: string,
    record: e2ee.ChatStatusRecord,
    heads?: ReadonlyMap<string, string[]>,
  ): Promise<ChatRoomStatus | undefined> {
    let opened: OpenedChat | undefined;
    for (const refresh of [false, true]) {
      try {
        const keys = await this.#keys(refresh);
        const known = heads ?? (await this.#headsOf(room, refresh));
        opened = await e2ee.openChat(keys, room, record, known ? { heads: known } : {});
        break;
      } catch {
        // A membership or group head change may be newer than the cached view.
      }
    }
    if (!opened) throw new HeraldError('This status could not be opened.', 0);
    const state = opened.kind === 'status' ? opened.status?.state : undefined;
    if (!state || !STATUS_STATES.has(state)) return undefined;
    const text = opened.status!.text;
    return {
      state: (state === 'busy' ? 'working' : state) as ChatStatus['state'],
      ...(typeof text === 'string' && text.length <= 120 ? { text } : {}),
      by: record.sender,
      at: record.at,
    };
  }
  /**
   * Pins `text` (markdown) under `key`, or replaces the pin there in place: no message, no unread,
   * no wake. Each sender (a person, or `sub`, an agent of this connection) holds up to 4 pins, a
   * connection 6 across its agents, a room 12. Pins for the same slot while one is in flight
   * coalesce: only the latest is sent. Aborting a call ends only that call.
   */
  async pin(room: string, key: string, text: string, options: ChatPinOptions = {}): Promise<void> {
    if (typeof text !== 'string' || text.length > PIN_TEXT)
      throw new HeraldError(`A pinned message is at most ${PIN_TEXT} characters.`, 400);
    await this.#queuePin(room, key, text, options);
  }
  /** Clears the pin under `key`; false when there was none. */
  unpin(room: string, key: string, options: ChatPinOptions = {}): Promise<boolean> {
    return this.#queuePin(room, key, null, options);
  }
  /**
   * Writes to one slot (resolved room, agent, key) run in call order. A pin queued behind a
   * running write absorbs later pins; an unpin never merges. Each caller settles on its own and
   * a write is cancelled only when every caller it serves has aborted.
   */
  async #queuePin(room: string, key: string, text: string | null, options: ChatPinOptions) {
    if (typeof key !== 'string' || !PIN_KEY.test(key))
      throw new HeraldError('A pin key is 1 to 64 of A-Z, a-z, 0-9, _, . and -.', 400);
    const { signal } = options;
    const sub = options.sub ?? '';
    // One agent's calls enter one at a time, so resolving a person or `owner` cannot reorder
    // them; other agents' calls do not wait, and an abort leaves the line.
    signal?.throwIfAborted();
    const pending = this.#pinTurns.get(sub);
    if (ROOM_ID.test(room) && !pending) return this.#enqueuePin(room, key, sub, text, signal);
    const before = pending ?? Promise.resolve();
    let leave = () => {};
    const turn = new Promise<void>((done) => (leave = done));
    this.#pinTurns.set(sub, turn);
    void turn.then(() => this.#pinTurns.get(sub) === turn && this.#pinTurns.delete(sub));
    let queued: Promise<boolean>;
    try {
      await abortable(before, signal);
      signal?.throwIfAborted();
      const id = ROOM_ID.test(room)
        ? room
        : (await abortable(this.#dm(room, options.sub, 'sub', signal), signal)).id;
      signal?.throwIfAborted();
      queued = this.#enqueuePin(id, key, sub, text, signal);
    } finally {
      // After the call ahead, so an abort cannot let later calls overtake it.
      void before.then(leave);
    }
    return queued;
  }
  #enqueuePin(
    id: string,
    key: string,
    sub: string,
    text: string | null,
    signal: AbortSignal | undefined,
  ) {
    const name = `${id}\n${sub}\n${key}`;
    const slot = this.#pinning.get(name) ?? { tail: Promise.resolve(), jobs: 0 };
    return new Promise<boolean>((resolve, reject) => {
      let job = slot.queued;
      if (!job || job.clear || text === null || job.abort.signal.aborted) {
        const made: PinJob = { clear: text === null, waiters: [], abort: new AbortController() };
        job = made;
        slot.queued = made;
        slot.jobs++;
        slot.tail = slot.tail.then(async () => {
          if (slot.queued === made) slot.queued = undefined;
          if (!made.waiters.length) return;
          try {
            const body = made.clear ? null : made.waiters.at(-1)!.text;
            const done = await this.#writePin(id, key, body, sub, made.abort.signal);
            for (const w of made.waiters) w.resolve(done);
          } catch (error) {
            for (const w of made.waiters) w.reject(error);
          }
        });
        void slot.tail.then(() => {
          if (!--slot.jobs) this.#pinning.delete(name);
        });
        this.#pinning.set(name, slot);
      }
      const mine = job;
      const onAbort = () => {
        const at = mine.waiters.indexOf(waiter);
        if (at < 0) return;
        mine.waiters.splice(at, 1);
        if (!mine.waiters.length) {
          mine.abort.abort(signal!.reason);
          // Not started yet: nothing is left to write, so later pins must not join it.
          if (slot.queued === mine) slot.queued = undefined;
        }
        reject(signal!.reason);
      };
      const off = () => signal?.removeEventListener('abort', onAbort);
      const waiter: PinWaiter = {
        text,
        resolve: (done) => (off(), resolve(done as boolean)),
        reject: (error) => (off(), reject(error)),
      };
      mine.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  async #writePin(
    room: string,
    key: string,
    text: string | null,
    sub: string,
    signal: AbortSignal,
  ) {
    const pinPath = (id: string) => `${path(id)}/pins/${encodeURIComponent(key)}`;
    if (text === null) {
      const query = sub ? `?sub=${encodeURIComponent(sub)}` : '';
      const done = await this.#request<{ cleared: boolean }>(pinPath(room) + query, undefined, {
        method: 'DELETE',
        signal,
      });
      return done.cleared;
    }
    const id = crypto.randomUUID();
    const view = await this.open(room);
    for (let attempt = 0; ; attempt++) {
      const fresh = attempt ? await this.open(view.id) : view;
      const keys = await this.#keys(attempt ? 'force' : false);
      const envelope = await e2ee.sealChat(
        keys,
        fresh,
        { id, text, kind: 'pin', sub, pin: { key } },
        this.#trust(fresh.id),
      );
      try {
        await this.#request(
          pinPath(fresh.id),
          { id, envelope, headVersion: fresh.headVersion, ...(sub ? { sub } : {}) },
          { method: 'PUT', signal },
        );
        return true;
      } catch (error) {
        if (attempt || !(error instanceof HeraldError) || error.code !== 'ROOM_STALE') throw error;
      }
    }
  }
  /** The room's pins this client can open, oldest first. */
  async pins(room: string, options: ChatRoomOptions = {}): Promise<ChatPin[]> {
    const view = await this.#dm(room, options.sub);
    const { pins } = await this.#request<{ pins: e2ee.ChatPinRecord[] }>(`${path(view.id)}/pins`);
    const opened = await Promise.all(
      pins.map((record) => this.#pin(view.id, record).catch(() => undefined)),
    );
    return opened.filter((p): p is ChatPin => !!p);
  }
  /** Opens a pin record, refreshing keys and heads once like a status. */
  async #pin(room: string, record: e2ee.ChatPinRecord): Promise<ChatPin> {
    for (const refresh of [false, true]) {
      try {
        const keys = await this.#keys(refresh);
        const known = await this.#headsOf(room, refresh);
        const opened = await e2ee.openChat(keys, room, record, known ? { heads: known } : {});
        const { key, sender, sub, at, pinnedAt } = record;
        return { key, sender, sub, text: opened.text, at, pinnedAt };
      } catch {
        // A membership or group head change may be newer than the cached view.
      }
    }
    throw new HeraldError('This pin could not be opened.', 0);
  }
  /**
   * Marks the room read up to `seq`; `sub`, an agent of this connection people can reach, also
   * moves that agent's own mark, which members see as its read receipt.
   */
  async markRead(
    room: string,
    seq: number,
    options: ChatRoomOptions = {},
  ): Promise<{ readSeq: number; agentReadSeq?: number }> {
    const id = ROOM_ID.test(room) ? room : (await this.#dm(room, options.sub)).id;
    return this.#request(`${path(id)}/read`, { seq, ...defined({ sub: options.sub }) });
  }
  /** Signs the next head of a group, named by its room id; an agent owner may add or remove agents only. */
  async updateGroup(
    room: string,
    change: { add?: string[]; remove?: string[]; owners?: string[] },
  ): Promise<ChatRoom> {
    if (!ROOM_ID.test(room)) throw new HeraldError('A group is named by its room id.', 400);
    const view = await this.open(room);
    const tip =
      view.chain?.at(-1)?.head ??
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
    return this.#verified(await this.#request<ChatRoom>(`${path(view.id)}/heads`, signed));
  }
  /** The room for an id, or the DM with a person or `owner` through the acting agent (`sub` or `for`). */
  #dm(target: string, agent?: string, option = 'sub', signal?: AbortSignal) {
    if (ROOM_ID.test(target)) return this.#openRoom(target, undefined, signal);
    if (!agent)
      throw new HeraldError(
        `A connection speaks as one of its agents: pass \`${option}\`.`,
        400,
        undefined,
        undefined,
        'AGENT_REQUIRED',
      );
    return this.#openRoom(target, agent, signal);
  }
  async #post(target: string, text: string, options: ChatSendOptions, extra: Posted = {}) {
    const id = options.id ?? crypto.randomUUID();
    const { audience, sub, replyTo, mentions, reference, signal, tags, summary } = options;
    const files = await Promise.all((options.files ?? []).map(readFileInput));
    const count = (options.attachments?.length ?? 0) + files.length;
    if (count > chatFileLimits.count)
      throw new HeraldError(`A message carries at most ${chatFileLimits.count} files.`, 400);
    for (const file of files)
      if (e2ee.sealedSize(file.data.byteLength) > limits.fileBytes)
        throw new HeraldError(`${file.name} is over ${limits.fileBytes / 1e6} MB.`, 413);
    if (summary !== undefined && summary.length > 200)
      throw new HeraldError('A summary is at most 200 characters.', 400);
    const forward = options.forward && e2ee.chatForward(options.forward);
    if (options.forward && !forward)
      throw new HeraldError(
        'A forward names a room id, a seq of at least 1 and that message id.',
        400,
      );
    const names = this.#sealedNames([sub, ...(tags ?? [])], options.names);
    const { kind, event, form, rules } = extra;
    const uploaded = await Promise.all(
      files.map(async (file) => {
        const { name, data, type } = await shrinkImage(file);
        return this.attach(target, name, data, type, { signal, sub });
      }),
    );
    const attachments = [...(options.attachments ?? []), ...uploaded];
    for (let attempt = 0; ; attempt++) {
      const room = await this.#dm(target, sub);
      const keys = await this.#keys(attempt ? 'force' : false);
      const input = {
        id,
        text,
        ...defined({ kind, audience, sub, mentions, reference, forward, event, form }),
        ...(attachments.length ? { attachments } : {}),
        ...defined({ summary }),
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
        ...(attachments.length ? { attachments: attachments.map((a) => a.id) } : {}),
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
  /** Answers a form as `sub`, the answering agent of this connection; `secrets` are sealed to the asker alone. */
  async answer(
    target: string,
    seq: number,
    answers: Record<string, unknown>,
    options: {
      secrets?: Record<string, unknown>;
      sub?: string;
      id?: string;
      signal?: AbortSignal;
    } = {},
  ) {
    const id = options.id ?? crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      const room = await this.#dm(target, options.sub);
      const keys = await this.#keys(attempt ? 'force' : false);
      const form = (await this.read(room.id, { after: seq - 1, limit: 1 })).messages[0];
      if (form?.seq !== seq || form.kind !== 'form') throw new HeraldError('No such form.', 404);
      const asker = keys.recipient(form.sender);
      if (!asker) throw new e2ee.E2eeError('The asker is not verified.');
      const seal = (input: e2ee.ChatSealInput) =>
        e2ee.sealChat(keys, room, input, this.#trust(room.id));
      const names = this.#sealedNames([options.sub]);
      const input = {
        id,
        text: '',
        kind: 'answer' as const,
        sub: options.sub,
        ...defined({ names }),
      };
      const body = {
        id,
        envelope: await seal({ ...input, audience: form.audience, answers }),
        headVersion: room.headVersion,
        ...(options.sub ? { sub: options.sub } : {}),
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
  /** Encrypts and uploads a file for one later message in this room. A person or `owner` target needs `sub`. */
  async attach(
    target: string,
    name: string,
    data: Uint8Array,
    type = 'application/octet-stream',
    options: { signal?: AbortSignal; sub?: string } = {},
  ): Promise<ChatAttachment> {
    const room = await this.#dm(target, options.sub);
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
  /** Downloads and decrypts a message's attachment, from the room that holds it (a room id). */
  async download(
    room: string,
    file: ChatAttachment,
    options: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    if (!ROOM_ID.test(room))
      throw new HeraldError('A download names the room id of its file.', 400);
    const response = await this.#raw(`${path(room)}/files/${file.id}`, options);
    if (!response.ok) await readError(response, 'File download failed.');
    if (!response.body) throw new HeraldError('Herald returned no file body.', response.status);
    return new Uint8Array(await new Response(e2ee.openFile(file.key, response.body)).arrayBuffer());
  }
  /**
   * Releases the wake up to `seq` and marks it read. A room keeps one wake per subagent: `subagent`
   * ('' for the connection) releases only that one and also marks that agent's read, when people
   * can reach it.
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
   * `lease` is how long, in seconds, a crashed caller holds the wake before it fires again. A
   * person or `owner` target needs `for`, the agent whose DM it is.
   */
  async next(
    target: string,
    options: { timeout?: number; lease?: number; signal?: AbortSignal; for?: string } = {},
  ): Promise<ChatWake | undefined> {
    const room = await this.#dm(target, options.for, 'for');
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
   * again when the lease lapses. `onStop` gets stop requests, `onRoom` archive, restore, delete and status
   * changes, `onPin` pins set or cleared, and `onForm` a form answered, expired or closed, as they
   * arrive; none is replayed.
   */
  wakes(
    handler: (wake: ChatWake) => void | Promise<void>,
    options: {
      signal?: AbortSignal;
      rooms?: string[];
      lease?: number;
      onError?: (error: unknown, room?: string) => void;
      onStop?: (stop: ChatStop) => void | Promise<void>;
      onRoom?: (event: ChatRoomEvent) => void | Promise<void>;
      onPin?: (event: ChatPinEvent) => void | Promise<void>;
      onForm?: (event: ChatFormEvent) => void | Promise<void>;
    } = {},
  ): Promise<void> {
    const { signal } = options;
    const allowed = options.rooms && new Set(options.rooms);
    const queues = new Map<string, Promise<void>>();
    const statuses = new Map<string, Promise<void>>();
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
        const { room, subagent, by } = frame;
        if (typeof room !== 'string' || !ROOM_ID.test(room) || (allowed && !allowed.has(room)))
          return;
        const report = (fn: (() => unknown) | undefined) => {
          try {
            const done = fn?.();
            if (done instanceof Promise) done.catch((error) => options.onError?.(error, room));
          } catch (error) {
            options.onError?.(error, room);
          }
        };
        if (frame.type === 'stop' && typeof subagent === 'string' && typeof by === 'string')
          report(() => options.onStop?.({ room, subagent, by }));
        else if (frame.type === 'deleted') {
          this.#forget(room);
          report(() => options.onRoom?.({ room, deleted: true }));
        } else if (frame.type === 'room') {
          const { archivedAt } = frame;
          if (archivedAt === null || typeof archivedAt === 'number')
            report(() => options.onRoom?.({ room, archivedAt }));
        } else if (frame.type === 'status') {
          // One chain per room keeps a clear from overtaking the status it follows.
          const { status: record } = frame;
          const next = (statuses.get(room) ?? Promise.resolve()).then(async () => {
            try {
              if (record === null) return await options.onRoom?.({ room, status: null });
              if (!record || typeof record !== 'object') return;
              const status = await this.#status(room, record as e2ee.ChatStatusRecord);
              if (status) await options.onRoom?.({ room, status });
            } catch (error) {
              // The old status no longer holds and this one cannot be read: show none.
              report(() => options.onRoom?.({ room, status: null }));
              options.onError?.(error, room);
            }
          });
          statuses.set(room, next);
        } else if (frame.type === 'form' && options.onForm) {
          const { seq, state, sender } = frame;
          if (
            typeof seq !== 'number' ||
            !Number.isSafeInteger(seq) ||
            !state ||
            typeof state !== 'object'
          )
            return;
          const chain = `${room} form`;
          const next = (statuses.get(chain) ?? Promise.resolve()).then(async () => {
            try {
              const wire = state as e2ee.FormState;
              if (typeof wire.status !== 'string') return;
              const asker = typeof sender === 'string' ? sender : '';
              const event = await this.#formState(room, seq, wire, asker);
              await options.onForm?.({ ...event, room, seq });
            } catch (error) {
              options.onError?.(error, room);
            }
          });
          statuses.set(chain, next);
        } else if (frame.type === 'pin' && options.onPin) {
          const { sender, sub, key, pin: record } = frame;
          if (typeof sender !== 'string' || typeof sub !== 'string' || typeof key !== 'string')
            return;
          const event = { room, sender, sub, key };
          const chain = `${room} pin`;
          const next = (statuses.get(chain) ?? Promise.resolve()).then(async () => {
            let pin: ChatPin | null = null;
            try {
              if (record && typeof record === 'object')
                pin = await this.#pin(room, record as e2ee.ChatPinRecord);
            } catch (error) {
              options.onError?.(error, room);
            }
            report(() => options.onPin?.({ ...event, pin }));
          });
          statuses.set(chain, next);
        }
      },
      replay,
      signal,
    ).then(() => Promise.allSettled(queues.values()).then(() => undefined));
  }
  /**
   * Waits for the next wake and returns its messages, or with `after` for anything from others
   * past that seq, acknowledged. Returns an empty list when the timeout passes. A person or
   * `owner` target needs `for`, the agent whose DM it is.
   */
  async wait(
    target: string,
    options: { after?: number; timeout?: number; signal?: AbortSignal; for?: string } = {},
  ): Promise<ChatMessage[]> {
    if (options.after === undefined) return (await this.next(target, options))?.messages ?? [];
    const room = await this.#dm(target, options.for, 'for');
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
        await this.ack(room.id, found.at(-1)!.seq, options.for);
        return found;
      }
      await this.#subscribe(
        (message) => {
          found.push(message);
          stop.abort();
        },
        {
          signal: stop.signal,
          rooms: [room.id],
          cursors: new Map([[room.id, after]]),
          ack: true,
          for: options.for,
        },
      );
      return found;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  /**
   * Delivers each new message from others, in order per room, until the signal aborts, settling
   * the wakes of `for` (an agent DM's own agent by default).
   */
  listen(
    handler: (message: ChatMessage) => void | Promise<void>,
    options: {
      signal?: AbortSignal;
      rooms?: string[];
      for?: string;
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
      for?: string;
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
        if (options.ack) await this.ack(message.room, message.seq, options.for);
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
/** A path is read in Node; its name is the base name. */
async function readFileInput(file: string | ChatFileInput): Promise<ChatFile> {
  if (typeof file !== 'string') return { ...file, type: file.type || fileTypeOf(file.name) };
  const { readFile } = await import('node:fs/promises');
  const name = file.split(/[\\/]/).pop() || file;
  return { name, data: new Uint8Array(await readFile(file)), type: fileTypeOf(name) };
}
