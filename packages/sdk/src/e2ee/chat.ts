import { b64u } from './bytes';
import { canon } from './canon';
import type { SealedEnvelope } from '../schema/e2ee';
import { E2eeError } from './bytes';
import {
  isWorkspace,
  open,
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
});
export interface ChatMember {
  principal: string;
  type: 'human' | 'agent';
  /** The recipient kid this member must be sealed to. */
  kid: string;
  readSeq: number;
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
export interface ChatRoom {
  id: string;
  kind: RoomKind;
  nonce: string;
  head: string;
  headVersion: number;
  lastSeq: number;
  lastAt: number;
  readSeq: number;
  unread: number;
  members: ChatMember[];
  title?: ChatRecord;
  /** Group rooms: every signed head, oldest first. */
  chain?: SignedChatHead[];
  hopLimit?: number;
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
  kind: ChatRecord['kind'];
  text: string;
  seen: number;
  mentions?: string[];
  event?: ChatEvent;
  form?: Record<string, unknown>;
  answers?: Record<string, unknown>;
  attachments?: ChatAttachment[];
  /** A sender-quoted copy of an Inbox request; never fetched or re-verified from the Inbox. */
  reference?: Record<string, unknown>;
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
}
async function verifyGroup(keys: ChatKeys, room: ChatRoom, trust: RoomTrust) {
  const chain = room.chain ?? fail('The group has no head.');
  const pin = trust.pins?.get(room.id);
  const tip = await verifyHeadChain(
    keys,
    room,
    chain,
    (hash) => pin?.hash === hash || !!trust.vouched?.(hash),
  );
  await checkPin(trust.pins, room.id, chain, tip);
  const head = chain.at(-1)!.head;
  if (room.head !== tip || room.headVersion !== head.version) fail('The room head is stale.');
  if (!head.members.includes(keys.principal)) fail('This key is not a member of the room.');
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
  if (!principals.includes(keys.principal)) fail('This key is not a member of the room.');
  if ((await roomId(principals, room.nonce)) !== room.id) fail('The room id does not match.');
  for (const m of room.members) {
    if (m.type !== (m.principal.startsWith('a:') ? 'agent' : 'human')) fail('Invalid room member.');
    if (keys.recipient(m.principal)?.kid !== m.kid) fail(`Unverified member ${m.principal}.`);
  }
}
/** Every head a message in this room may legitimately sign. */
export async function roomHeads(room: ChatRoom): Promise<Set<string>> {
  if (room.kind !== 'group') return new Set([room.id]);
  return new Set(await Promise.all((room.chain ?? []).map((link) => headHash(link.head))));
}
/** A group seals to who is on the head, still in the room and still on the roster. */
const recipients = (keys: ChatKeys, room: ChatRoom, audience: ChatRecord['audience']) => {
  const listed = groupHead(room)?.members;
  return room.members
    .filter((m) => !listed || listed.includes(m.principal))
    .filter((m) => audience === 'all' || humanP(m.principal) || m.principal === keys.principal)
    .map((m) => keys.recipient(m.principal))
    .filter((key): key is RecipientKey => !!key);
};
export type ChatSealInput = Partial<Omit<ChatPayload, 'kind' | 'text' | 'seen'>> & {
  id: string;
  text: string;
  kind?: ChatRecord['kind'];
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
  const audience = input.audience ?? 'all';
  const { id, text, kind, sub, seen, to, ctxAudience, audience: _a, ...extra } = input;
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
  });
  return seal({ payload, ctx, signer: keys.signer, to: to ?? recipients(keys, room, audience) });
}
const fieldsMatch = (a: ChatRecord['event'], b: ChatEvent | undefined) =>
  (!a && !b) || (a && b && a.type === b.type && a.target === b.target);
/** Verifies the sender named by the record, the context and the sealed kind, then decrypts. */
export async function openChat(
  keys: ChatKeys,
  roomOf: string,
  record: ChatRecord,
  options: { heads?: ReadonlySet<string> } = {},
): Promise<OpenedChat> {
  const envelope = record.envelope ?? fail('The message has no content.');
  const who = keys.verifier(record.sender) ?? fail(`Unverified sender ${record.sender}.`);
  if (envelope.from !== who.kid) fail('The message has the wrong signer.');
  if (options.heads && !options.heads.has(String(envelope.ctx.head)))
    fail('The message names an unknown room head.');
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
