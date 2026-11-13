import { b64u } from './bytes';
import { canon } from './canon';
import type { Recipient, SealedEnvelope } from '../schema/e2ee';
import { E2eeError } from './bytes';
import {
  grant,
  isWorkspace,
  open,
  openKey,
  seal,
  type Ctx,
  type Opener,
  type RecipientKey,
  type Signer,
} from './envelope';
import { H } from './hash';
import {
  checkPin,
  headHash,
  verifyHeadChain,
  type HeadPins,
  type SignedChatHead,
} from './chat-head';
export type RoomKind = 'dm' | 'session' | 'group';
export type NotifyRule = 'all' | 'tagged' | 'tagged_or_replied' | 'never';
export type ContextMode = 'message' | 'recent' | 'unseen';
export interface ChatContextInput {
  account: string;
  room: string;
  id: string;
  audience: 'all' | 'humans';
  sub: string;
  head: string;
  /** The sender principal; team workspaces only. */
  member?: string;
  /** The newest chat policy version the sender has seen; team workspaces only. */
  policy?: number;
}
/** Unique key of a two-party room, order independent. */
export const pairKey = (principals: string[]) => [...principals].sort().join('|');
/** A room id commits to its members and a nonce; clients recompute it before sealing. */
export const roomId = async (principals: string[], nonce: string) =>
  b64u.encode(await H('room', canon({ members: [...principals].sort(), nonce })));
export const chatContext = (input: ChatContextInput): Ctx => ({
  t: 'chat',
  account: input.account,
  room: input.room,
  id: input.id,
  audience: input.audience,
  sub: input.sub,
  head: input.head,
  ...(input.member === undefined ? {} : { member: input.member }),
  ...(input.policy === undefined ? {} : { policy: input.policy }),
});
export interface ChatMember {
  principal: string;
  type: 'human' | 'agent';
  /** The recipient kid this member must be sealed to. */
  kid: string;
  readSeq: number;
  /** Messages up to this seq predate the member; shared history may cover them. */
  joinedSeq?: number;
  notify?: NotifyRule | 'default';
  context?: ContextMode;
}
/** Folded by clients; an edit counts only from the original sender. */
export type ChatEvent =
  | { type: 'reaction'; target: number; emoji: string; remove?: boolean }
  | { type: 'edit'; target: number };
export type FormState = {
  status: 'open' | 'answered' | 'expired';
  by?: string;
  answer?: number;
};
export interface ChatRecord {
  seq: number;
  id: string;
  sender: string;
  sub: string;
  at: number;
  /** `server` lines and `tombstone`s carry no envelope. */
  kind: 'message' | 'title' | 'event' | 'form' | 'answer' | 'server' | 'tombstone';
  audience: 'all' | 'humans';
  replyTo?: number;
  envelope?: SealedEnvelope;
  /** Declared in the clear so the server can route; repeated in the signed payload. */
  mentions?: string[];
  event?: Pick<ChatEvent, 'type' | 'target'>;
  formState?: FormState;
  /** Secret form fields, sealed to the asker alone; only the asker receives this. */
  secrets?: SealedEnvelope;
  /** What a `server` line says; set by the server, never by a member. */
  notice?: string;
}
/** A room's sealed status: a record that never sits in the message stream (`seq` is 0). */
export type ChatStatusRecord = Omit<ChatRecord, 'kind'> & { kind: 'status' };
export interface ChatRoom {
  id: string;
  kind: RoomKind;
  nonce: string;
  head: string;
  headVersion: number;
  lastSeq: number;
  lastAt: number;
  /** When the room was archived (ms), `null` while active. An archived room is read-only. */
  archivedAt?: number | null;
  readSeq: number;
  unread: number;
  members: ChatMember[];
  title?: ChatRecord;
  /** The room's one sealed status, when set; older clients ignore it. */
  status?: ChatStatusRecord;
  /** Group rooms: every signed head, oldest first. */
  chain?: SignedChatHead[];
  /** Agent turns in a row, between different agents, before wakes pause; 0 means no limit. */
  hopLimit?: number;
  /** The agent key of a DM with one agent. */
  agent?: string;
  /** Agents of member connections in this room, live or not, with their own settings. */
  agents?: RoomAgent[];
}
/** `agents`: people's messages never reach it, nor do their tags wake it. */
export type SubagentReach = 'all' | 'agents';
export type AgentReach = SubagentReach;
/** An agent in a room. `live`: registered now; a tag still wakes one that is not, within reach. */
export interface RoomAgent {
  connection: string;
  key: string;
  notify: NotifyRule;
  /** Overrides its connection's context when set. */
  context?: ContextMode;
  reach: AgentReach;
  live: boolean;
}
export interface ChatAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  /** The content key, base64url; sealed with the message. */
  key: string;
}
/** What a chat envelope seals. `seen` is the sender's last-seen seq, so readers can spot gaps. */
export interface ChatPayload extends Record<string, unknown> {
  kind: ChatRecord['kind'] | 'status';
  text: string;
  seen: number;
  mentions?: string[];
  /** The subagent keys addressed, signed with the message; only set when non-empty. */
  tags?: string[];
  event?: ChatEvent;
  form?: Record<string, unknown>;
  answers?: Record<string, unknown>;
  attachments?: ChatAttachment[];
  /** A one-line stand-in (max 200 chars) clients show while the message is collapsed. */
  summary?: string;
  /** A room status: its `state` is one of `presenceStates`; `text` is a short note. */
  status?: { state: string; text?: string };
  /** A sender-quoted copy of an Inbox request; never fetched or re-verified from the Inbox. */
  reference?: Record<string, unknown>;
  /** Display names (1 to 60 chars) for the `sub` and `tags` keys, as the sender knew them. */
  names?: Record<string, string>;
}
export type OpenedChat = ChatPayload & { mentionsMismatch?: true };
/** Verified keys of the local party; each client fills this from its own key store. */
export interface ChatKeys {
  account: string;
  principal: string;
  signer: Signer;
  openers: Opener[];
  /** The verified key a member is sealed to. */
  recipient(principal: string): RecipientKey | undefined;
  /** The verified signing key a member's messages must carry. */
  verifier(principal: string): { kid: string; sign: string } | undefined;
  /** An agent's verified effective teams; a team room never seals to an agent outside its team. */
  teamsOf?(principal: string): string[] | undefined;
  /** Verified keys of admins who read every room, only while the signed policy says so. */
  observers?(): RecipientKey[];
  /** The newest chat policy version seen; team members sign it into every message. */
  policy?: number;
  /** Called with the policy version a human member signed, so a fresh reader cannot be rolled back. */
  sawPolicy?(version: number): void;
}
const fail = (message: string): never => {
  throw new E2eeError(message);
};
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
const humanP = (p: string) => p.startsWith('h:');
export const groupHead = (room: ChatRoom) => room.chain?.at(-1)?.head;
/** What a room's members verify against: a pin or fresh message may vouch for the tip. */
export interface RoomTrust {
  pins?: HeadPins;
  vouched?: (hash: string) => boolean;
  /** Reading as a team manager outside the room, under the read policy. */
  observe?: boolean;
}
async function verifyGroup(keys: ChatKeys, room: ChatRoom, trust: RoomTrust) {
  const chain = room.chain ?? fail('The group has no head.');
  const pin = trust.pins?.get(room.id);
  const tip = await verifyHeadChain(
    keys,
    room,
    chain,
    (hash) => pin?.hash === hash || !!trust.vouched?.(hash),
    pin,
  );
  await checkPin(trust.pins, room.id, chain, tip);
  const head = chain.at(-1)!.head;
  if (room.head !== tip || room.headVersion !== head.version) fail('The room head is stale.');
  if (!trust.observe && !head.members.includes(keys.principal))
    fail('This key is not a member of the room.');
  for (const m of room.members)
    if (!head.members.includes(m.principal)) fail(`Unlisted member ${m.principal}.`);
}
/**
 * Two-party rooms recompute the id and require exactly the expected members. Groups verify the
 * signed head chain, so the server's member list can only ever narrow who is sealed to.
 */
export async function verifyChatRoom(
  keys: ChatKeys,
  room: ChatRoom,
  trust: RoomTrust = {},
): Promise<void> {
  if (room.kind === 'group') return verifyGroup(keys, room, trust);
  const principals = room.members.map((m) => m.principal);
  if (principals.length !== 2 || new Set(principals).size !== 2) fail('Unexpected room members.');
  if (!trust.observe && !principals.includes(keys.principal))
    fail('This key is not a member of the room.');
  if ((await roomId(principals, room.nonce)) !== room.id) fail('The room id does not match.');
  for (const m of room.members) {
    if (m.type !== (m.principal.startsWith('a:') ? 'agent' : 'human')) fail('Invalid room member.');
    if (keys.recipient(m.principal)?.kid !== m.kid) fail(`Unverified member ${m.principal}.`);
  }
}
/** Every head a message in this room may legitimately sign. */
export async function roomHeads(room: ChatRoom): Promise<Map<string, string[]>> {
  if (room.kind !== 'group') return new Map([[room.id, room.members.map((m) => m.principal)]]);
  const chain = room.chain ?? [];
  return new Map(
    await Promise.all(chain.map(async (l) => [await headHash(l.head), l.head.members] as const)),
  );
}
/**
 * Whether a verified message vouches for the head it names: only from a person on that head. A
 * head missing from the chain still counts, so a caller can see the chain was cut back.
 */
export const vouches = (heads: ReadonlyMap<string, string[]>, head: string, sender: string) => {
  const members = heads.get(head);
  return !members || (humanP(sender) && members.includes(sender));
};
/** May this agent be in a room of `team`? Unknown teams count as outside it. */
export const inTeam = (keys: ChatKeys, principal: string, team: string | undefined) =>
  !team || humanP(principal) || !keys.teamsOf || !!keys.teamsOf(principal)?.includes(team);
/**
 * A group seals to who is on the head, still in the room, still on the roster and, for agents, in
 * the room's team; plus key-holding managers while the verified read policy is on.
 */
const recipients = (keys: ChatKeys, room: ChatRoom, audience: ChatRecord['audience']) => {
  const head = groupHead(room);
  const out = room.members
    .filter((m) => !head || head.members.includes(m.principal))
    .filter((m) => inTeam(keys, m.principal, head?.team))
    .filter((m) => audience === 'all' || humanP(m.principal) || m.principal === keys.principal)
    .map((m) => keys.recipient(m.principal))
    .filter((key): key is RecipientKey => !!key);
  const kids = new Set(out.map((k) => k.kid));
  for (const key of keys.observers?.() ?? [])
    if (!kids.has(key.kid)) {
      out.push(key);
      kids.add(key.kid);
    }
  return out;
};
/**
 * Shared history: re-wraps messages a member joined after to their key, newest first, up to
 * `limit`. Humans-only messages are never shared with an agent.
 */
export async function shareHistory(
  keys: ChatKeys,
  member: ChatMember,
  records: ChatRecord[],
  limit = 500,
): Promise<Record<string, Recipient>> {
  const to = keys.recipient(member.principal) ?? fail(`Unverified member ${member.principal}.`);
  if (to.kid !== member.kid) fail(`Unverified member ${member.principal}.`);
  const out: Record<string, Recipient> = {};
  const picked = records
    .filter((r) => r.envelope && r.seq <= (member.joinedSeq ?? 0))
    .filter((r) => r.audience === 'all' || member.type === 'human')
    .sort((a, b) => b.seq - a.seq)
    .slice(0, limit);
  for (const r of picked) {
    const cek = await openKey(r.envelope!, keys.openers).catch(() => undefined);
    if (cek) out[r.seq] = await grant(r.envelope!, cek, to);
  }
  return out;
}
export type ChatSealInput = Partial<Omit<ChatPayload, 'kind' | 'text' | 'seen'>> & {
  id: string;
  text: string;
  kind?: ChatRecord['kind'] | 'status';
  audience?: ChatRecord['audience'];
  sub?: string;
  seen?: number;
  /** A context other than the room's head, for secret form fields. */
  to?: RecipientKey[];
  ctxAudience?: string;
};
export async function sealChat(
  keys: ChatKeys,
  room: ChatRoom,
  input: ChatSealInput,
  trust?: RoomTrust,
): Promise<SealedEnvelope> {
  await verifyChatRoom(keys, room, trust);
  const { id, text, kind, sub, seen, to, ctxAudience, audience: chosen, ...extra } = input;
  const audience = chosen ?? 'all';
  const payload: ChatPayload = {
    ...extra,
    kind: kind ?? 'message',
    text,
    seen: seen ?? room.lastSeq,
  };
  const ctx = chatContext({
    account: keys.account,
    room: room.id,
    id,
    audience: (ctxAudience ?? audience) as ChatRecord['audience'],
    sub: sub ?? '',
    head: room.head,
    member: isWorkspace(keys.account) ? keys.principal : undefined,
    policy: isWorkspace(keys.account) ? (keys.policy ?? 0) : undefined,
  });
  return seal({ payload, ctx, signer: keys.signer, to: to ?? recipients(keys, room, audience) });
}
const fieldsMatch = (a: ChatRecord['event'], b: ChatEvent | undefined) =>
  (!a && !b) || (a && b && a.type === b.type && a.target === b.target);
/** Verifies the sender named by the record, the context and the sealed kind, then decrypts. */
export async function openChat(
  keys: ChatKeys,
  roomOf: string,
  record: ChatRecord | ChatStatusRecord,
  options: { heads?: ReadonlyMap<string, string[]> } = {},
): Promise<OpenedChat> {
  const envelope = record.envelope ?? fail('The message has no content.');
  const who = keys.verifier(record.sender) ?? fail(`Unverified sender ${record.sender}.`);
  if (envelope.from !== who.kid) fail('The message has the wrong signer.');
  if (options.heads) {
    const members = options.heads.get(String(envelope.ctx.head));
    if (!members) fail('The message names an unknown room head.');
    if (!members!.includes(record.sender)) fail('The sender is not on that room head.');
  }
  const payload = await open<ChatPayload>(envelope, {
    recipients: keys.openers,
    signers: (kid) => (kid === who.kid ? who.sign : undefined),
    expect: {
      t: 'chat',
      account: keys.account,
      room: roomOf,
      id: record.id,
      audience: record.audience,
      sub: record.sub,
      ...(isWorkspace(keys.account) ? { member: record.sender } : {}),
    },
  });
  if (payload.kind !== record.kind || typeof payload.text !== 'string')
    fail('The message content is invalid.');
  if (!fieldsMatch(record.event, payload.event)) fail('The event does not match its record.');
  if (isWorkspace(keys.account) && humanP(record.sender))
    keys.sawPolicy?.(envelope.ctx.policy as number);
  const mentionsMismatch = !sameSet(record.mentions ?? [], payload.mentions ?? []);
  return { ...payload, ...(mentionsMismatch ? { mentionsMismatch: true as const } : {}) };
}
/** Secret form fields: sealed to the asker alone, under the answer's own id. */
export async function openChatSecrets(
  keys: ChatKeys,
  roomOf: string,
  record: ChatRecord,
): Promise<ChatPayload | undefined> {
  if (!record.secrets) return undefined;
  const who = keys.verifier(record.sender) ?? fail(`Unverified sender ${record.sender}.`);
  return open<ChatPayload>(record.secrets, {
    recipients: keys.openers,
    signers: (kid) => (kid === who.kid ? who.sign : undefined),
    expect: {
      t: 'chat',
      account: keys.account,
      room: roomOf,
      id: record.id,
      audience: 'asker',
      sub: record.sub,
      ...(isWorkspace(keys.account) ? { member: record.sender } : {}),
    },
  });
}
