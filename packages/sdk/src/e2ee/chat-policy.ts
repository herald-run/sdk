import { canon } from './canon';
import { E2eeError } from './bytes';
import { H } from './hash';
import { sign, verify } from './keys';
import type { VerifiedChain, WorkspaceIdentity } from './workspace';

/** A team workspace's chat settings, signed by the chain head so a server cannot set them. */
export interface ChatPolicy {
  v: 1;
  workspace: string;
  /** The head link that signed it; a later head needs a new policy. */
  n: number;
  head: string;
  /** Increases with every change; clients never go back to a lower one. */
  version: number;
  /** New messages are also sealed to roster members holding the `keys` capability. */
  adminRead: boolean;
}
export interface SignedChatPolicy {
  policy: ChatPolicy;
  sig: string;
}
const input = (policy: ChatPolicy) => H('chat-policy', canon({ ...policy }));
/** Signs the next policy as the chain head; `version` must exceed the current one. */
export async function signChatPolicy(
  chain: VerifiedChain,
  identity: WorkspaceIdentity,
  change: Pick<ChatPolicy, 'version' | 'adminRead'>,
): Promise<SignedChatPolicy> {
  if (identity.signPub !== chain.head.identity)
    throw new E2eeError('Policies are signed by the head.');
  const policy: ChatPolicy = {
    v: 1,
    workspace: chain.workspace,
    n: chain.head.n,
    head: chain.head.link,
    version: change.version,
    adminRead: change.adminRead,
  };
  return { policy, sig: await sign(identity.signPriv, await input(policy)) };
}
/**
 * The policy in force: one the current head signed, never older than `minVersion`. Anything
 * else, a missing policy included, reads as every setting off.
 */
export async function verifyChatPolicy(
  chain: VerifiedChain,
  signed: SignedChatPolicy | null | undefined,
  minVersion = 0,
): Promise<ChatPolicy | undefined> {
  const p = signed?.policy;
  if (
    p?.v !== 1 ||
    p.workspace !== chain.workspace ||
    p.n !== chain.head.n ||
    p.head !== chain.head.link ||
    !Number.isSafeInteger(p.version) ||
    p.version < 1 ||
    typeof p.adminRead !== 'boolean'
  )
    return undefined;
  if (p.version < minVersion) throw new E2eeError('The chat policy was rolled back.');
  return (await verify(chain.head.identity, signed!.sig, await input(p))) ? p : undefined;
}
