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
export type RoomKind = 'dm' | 'session';
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
}
export interface ChatRecord {
  seq: number;
  id: string;
  sender: string;
  sub: string;
  at: number;
  kind: 'message' | 'title' | 'event';
  audience: 'all' | 'humans';
  replyTo?: number;
  envelope: SealedEnvelope;
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
}
/** What a chat envelope seals. `seen` is the sender's last-seen seq, so readers can spot gaps. */
export interface ChatPayload extends Record<string, unknown> {
  kind: ChatRecord['kind'];
  text: string;
  seen: number;
}
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
/** Recomputes the id and requires exactly the expected members; never trust the server's list. */
export async function verifyChatRoom(keys: ChatKeys, room: ChatRoom): Promise<void> {
  const principals = room.members.map((m) => m.principal);
  // Two-party rooms only; group rooms need a signed head chain instead.
  if (principals.length !== 2 || new Set(principals).size !== 2) fail('Unexpected room members.');
  if (!principals.includes(keys.principal)) fail('This key is not a member of the room.');
  if ((await roomId(principals, room.nonce)) !== room.id) fail('The room id does not match.');
  for (const m of room.members) {
    if (m.type !== (m.principal.startsWith('a:') ? 'agent' : 'human')) fail('Invalid room member.');
    if (keys.recipient(m.principal)?.kid !== m.kid) fail(`Unverified member ${m.principal}.`);
  }
}
export async function sealChat(
  keys: ChatKeys,
  room: ChatRoom,
  input: {
    id: string;
    text: string;
    kind?: ChatRecord['kind'];
    audience?: ChatRecord['audience'];
    sub?: string;
    seen?: number;
  },
): Promise<SealedEnvelope> {
  await verifyChatRoom(keys, room);
  const audience = input.audience ?? 'all';
  const to = room.members
    .filter((m) => audience === 'all' || m.type === 'human' || m.principal === keys.principal)
    .map((m) => keys.recipient(m.principal)!);
  const payload: ChatPayload = {
    kind: input.kind ?? 'message',
    text: input.text,
    seen: input.seen ?? room.lastSeq,
  };
  const ctx = chatContext({
    account: keys.account,
    room: room.id,
    id: input.id,
    audience,
    sub: input.sub ?? '',
    head: room.head,
    member: isWorkspace(keys.account) ? keys.principal : undefined,
  });
  return seal({ payload, ctx, signer: keys.signer, to });
}
/** Verifies the sender named by the record, the context and the sealed kind, then decrypts. */
export async function openChat(
  keys: ChatKeys,
  roomOf: string,
  record: ChatRecord,
): Promise<ChatPayload> {
  const who = keys.verifier(record.sender) ?? fail(`Unverified sender ${record.sender}.`);
  if (record.envelope.from !== who.kid) fail('The message has the wrong signer.');
  const payload = await open<ChatPayload>(record.envelope, {
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
  return payload;
}
