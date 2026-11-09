import { b64u } from './bytes';
import { canon } from './canon';
import type { Ctx } from './envelope';
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
