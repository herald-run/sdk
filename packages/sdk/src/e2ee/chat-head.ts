import { b64u, E2eeError, utf8 } from './bytes';
import { canon } from './canon';
import { H } from './hash';
import { sign, verify } from './keys';
import type { Signer } from './envelope';

/** One version of a group's membership. Lists principals, never keys; `members` keep join order. */
export interface ChatHead {
  room: string;
  version: number;
  /** Hash of the previous head; empty on the first. */
  prev: string;
  owners: string[];
  members: string[];
}
export interface SignedChatHead {
  head: ChatHead;
  /** The human principal that signed. */
  by: string;
  /** The kid of the signing key. */
  from: string;
  sig: string;
}
/** A client's memory of the newest head it verified, so the server cannot roll a room back. */
export interface HeadPins {
  get(room: string): { version: number; hash: string } | undefined;
  set(room: string, pin: { version: number; hash: string }): void;
}
/** The verified keys head verification needs. */
export interface HeadKeys {
  account: string;
  verifier(principal: string): { kid: string; sign: string } | undefined;
}
const MAX_HEAD_MEMBERS = 64;
const fail = (message: string): never => {
  throw new E2eeError(message);
};
/** A group room's id commits to its creator and a nonce. */
export const groupRoomId = async (creator: string, nonce: string) =>
  b64u.encode(await H('chat-room', canon({ creator, nonce })));
export const headHash = async (head: ChatHead) =>
  b64u.encode(await H('chat-head', canon({ ...head })));
const signingInput = async (account: string, head: ChatHead) =>
  H('chat-head-sig', utf8(canon({ account, head: { ...head } })));
export async function signChatHead(
  input: { account: string; principal: string; signer: Signer },
  head: ChatHead,
): Promise<SignedChatHead> {
  return {
    head,
    by: input.principal,
    from: input.signer.kid,
    sig: await sign(input.signer.signPriv, await signingInput(input.account, head)),
  };
}
function checkShape(head: ChatHead) {
  const { owners, members } = head;
  if (
    !owners.length ||
    !members.length ||
    members.length > MAX_HEAD_MEMBERS ||
    new Set(owners).size !== owners.length ||
    new Set(members).size !== members.length ||
    owners.some((o) => !members.includes(o) || !o.startsWith('h:'))
  )
    fail('The group head is malformed.');
}
/** Who may sign the head after `prev`: an owner, or if none is left the earliest remaining human. */
export function maySign(
  prev: Pick<ChatHead, 'owners' | 'members'>,
  signer: string,
  onRoster: (principal: string) => boolean,
) {
  if (prev.owners.includes(signer)) return true;
  if (prev.owners.some(onRoster)) return false;
  // A signer who has since left cannot be placed in today's order; a later link vouches for it.
  return !onRoster(signer) || prev.members.find((m) => m.startsWith('h:') && onRoster(m)) === signer;
}
/**
 * Verifies a chain from the first head and returns its tip hash. A link whose signer has left the
 * roster or rotated keys cannot be checked directly, so a later verified link must commit to it,
 * or `trusted` (a pin or a verified recent message) must vouch for the tip.
 */
export async function verifyHeadChain(
  keys: HeadKeys,
  room: { id: string; nonce: string },
  chain: SignedChatHead[],
  trusted?: (hash: string) => boolean,
): Promise<string> {
  if (!chain.length) fail('The group has no head.');
  const onRoster = (p: string) => keys.verifier(p) !== undefined;
  let prev: ChatHead | undefined;
  let prevHash = '';
  let unchecked = false;
  for (const [i, link] of chain.entries()) {
    const { head, by } = link;
    if (head.room !== room.id || head.version !== i + 1 || head.prev !== prevHash)
      fail('The group head chain is broken.');
    checkShape(head);
    if (!by.startsWith('h:')) fail('Only people can change a group.');
    if (!prev) {
      if ((await groupRoomId(by, room.nonce)) !== room.id || !head.owners.includes(by))
        fail('The group creator does not match its id.');
    } else if (!maySign(prev, by, onRoster)) fail('The head signer is not an owner.');
    const who = keys.verifier(by);
    if (who && who.kid === link.from) {
      if (!(await verify(who.sign, link.sig, await signingInput(keys.account, head))))
        fail('Bad head signature.');
      unchecked = false;
    } else unchecked = true;
    prev = head;
    prevHash = await headHash(head);
  }
  if (unchecked && !trusted?.(prevHash)) fail('The group head signer is not verified.');
  return prevHash;
}
/** Rejects a chain older than, or forked from, what this client has already seen. */
export async function checkPin(
  pins: HeadPins | undefined,
  roomId: string,
  chain: SignedChatHead[],
  tip: string,
) {
  const pin = pins?.get(roomId);
  const version = chain.length;
  if (pin) {
    if (version < pin.version) fail('The group head was rolled back.');
    const at = await headHash(chain[pin.version - 1]!.head);
    if (at !== pin.hash) fail('The group head forked.');
  }
  pins?.set(roomId, { version, hash: tip });
}
