import type { AccountKeys, Certificate } from '../schema/e2ee';
import { b64u, bytesOf, fail } from './bytes';
import { canon } from './canon';
import { H } from './hash';
import { fingerprint, keySet, kid, sign, verify, type KeySet } from './keys';
import { now, randomBytes } from './random';
/** The account's secret keys: one identity seed and inbox seeds, newest last. */
export interface Keyring {
  v: 1;
  account: string;
  identity: string;
  inbox: { seed: string; created: string }[];
}
/** Key sets carry their account kids: the identity's signer kid and each inbox's recipient kid. */
export interface KeyringKeys {
  identity: KeySet;
  inbox: KeySet[];
  signerKid: string;
  inboxKid: string;
}
export interface AccountInfo {
  identity: string;
  inbox: string;
  signerKid: string;
  inboxKid: string;
}
export function checkKeyring(keyring: Keyring): Keyring {
  const ok =
    keyring?.v === 1 &&
    typeof keyring.account === 'string' &&
    keyring.account !== '' &&
    Array.isArray(keyring.inbox) &&
    keyring.inbox.length > 0 &&
    keyring.inbox.every((entry) => typeof entry?.created === 'string');
  if (!ok) fail('Malformed keyring.');
  bytesOf(keyring.identity, 32);
  for (const entry of keyring.inbox) bytesOf(entry.seed, 32);
  return keyring;
}
export function createKeyring(account: string): Keyring {
  const seed = () => b64u.encode(randomBytes(32));
  const identity = seed();
  return { v: 1, account, identity, inbox: [{ seed: seed(), created: now() }] };
}
export async function keyringKeys(keyring: Keyring): Promise<KeyringKeys> {
  checkKeyring(keyring);
  const own = await keySet(keyring.identity);
  const idPub = b64u.decode(own.signPub);
  const identity = { ...own, kid: await kid(idPub) };
  const inbox: KeySet[] = [];
  for (const entry of keyring.inbox) {
    const set = await keySet(entry.seed);
    inbox.push({ ...set, kid: await kid(idPub, b64u.decode(set.boxPub)) });
  }
  return { identity, inbox, signerKid: identity.kid, inboxKid: inbox.at(-1)!.kid };
}
/** The signed statement the server publishes: identity key and newest inbox key. */
export async function accountStatement(keyring: Keyring): Promise<AccountKeys> {
  const keys = await keyringKeys(keyring);
  const newest = keyring.inbox.at(-1)!;
  const statement = {
    v: 1 as const,
    account: keyring.account,
    identity: keys.identity.signPub,
    inbox: keys.inbox.at(-1)!.boxPub,
    created: newest.created,
  };
  return {
    statement,
    sig: await sign(keys.identity.signPriv, await H('account', canon(statement))),
  };
}
/** Accepts a published statement only under the pinned fingerprint (and account, when given). */
export async function verifyAccount(
  keys: AccountKeys,
  pinnedFp: string,
  account?: string,
): Promise<AccountInfo> {
  const { statement } = keys;
  if (statement?.v !== 1) fail('Unsupported statement version.');
  if ((await fingerprint(statement.identity)) !== pinnedFp) fail('Account fingerprint mismatch.');
  if (account !== undefined && statement.account !== account) fail('Account mismatch.');
  if (!(await verify(statement.identity, keys.sig, await H('account', canon(statement)))))
    fail('Bad statement signature.');
  const identity = bytesOf(statement.identity, 32);
  return {
    identity: statement.identity,
    inbox: statement.inbox,
    signerKid: await kid(identity),
    inboxKid: await kid(identity, bytesOf(statement.inbox, 32)),
  };
}
/** The owner's approval of an integration key set. */
export async function certify(
  keyring: Keyring,
  keys: { sign: string; box: string },
): Promise<Certificate> {
  const { identity } = await keyringKeys(keyring);
  const certificate = {
    v: 1 as const,
    account: keyring.account,
    kid: await kid(bytesOf(keys.sign, 32), bytesOf(keys.box, 32)),
    sign: keys.sign,
    box: keys.box,
    created: now(),
  };
  return { certificate, sig: await sign(identity.signPriv, await H('cert', canon(certificate))) };
}
export async function verifyCertificate(
  cert: Certificate,
  identitySignPub: string,
  account: string,
) {
  const body = cert.certificate;
  if (body?.v !== 1) fail('Unsupported certificate version.');
  if (body.account !== account) fail('Certificate account mismatch.');
  if (body.kid !== (await kid(bytesOf(body.sign, 32), bytesOf(body.box, 32))))
    fail('Certificate kid mismatch.');
  if (!(await verify(identitySignPub, cert.sig, await H('cert', canon(body)))))
    fail('Bad certificate signature.');
  return { kid: body.kid, sign: body.sign, box: body.box };
}
export interface ReceiverClaim {
  message: string;
  claimId: string;
  publicKey: unknown;
  /** Team workspaces: the claiming member, whose personal identity signs. */
  member?: string;
}
const receiverInput = ({ message, claimId, publicKey, member }: ReceiverClaim) =>
  H(
    'receiver',
    canon({ message, claimId, publicKey, ...(member === undefined ? {} : { member }) }),
  );
/** Signs a secret receiver's one-time public key with the account identity. */
export async function signReceiver(keyring: Keyring, claim: ReceiverClaim): Promise<string> {
  const { identity } = await keyringKeys(keyring);
  return sign(identity.signPriv, await receiverInput(claim));
}
export async function verifyReceiver(sig: string, identitySignPub: string, claim: ReceiverClaim) {
  if (!(await verify(identitySignPub, sig, await receiverInput(claim))))
    fail('Bad receiver signature.');
}
