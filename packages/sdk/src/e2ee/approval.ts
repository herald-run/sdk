import type { SealedEnvelope } from '../schema/e2ee';
import { b64u, bytesOf, fail } from './bytes';
import {
  checkCtx,
  checkEnvelope,
  decryptPayload,
  seal,
  unwrapKey,
  verifySig,
  type Opener,
} from './envelope';
import { H } from './hash';
import { importPrivate, kid } from './keys';
import { checkKeyring, keyringKeys, type Keyring } from './keyring';
import { randomBytes } from './random';
// Device approval: a locked device commits to a transfer key, the approver challenges with a
// nonce, both show a four-digit code, and the approver seals the keyring to the transfer key.
export interface TransferKey {
  seed: string;
  kid: string;
  boxPub: string;
  boxPriv: CryptoKey;
}
/** A one-time X25519 key; keep `seed` to resume after a reload. */
export async function transferKey(seed?: Uint8Array | string): Promise<TransferKey> {
  const raw = seed === undefined ? randomBytes(32) : bytesOf(seed, 32);
  const { priv, pub } = await importPrivate('X25519', raw);
  return { seed: b64u.encode(raw), kid: await kid(pub), boxPub: b64u.encode(pub), boxPriv: priv };
}
export const approvalNonce = () => b64u.encode(randomBytes(32));
export const deviceCommit = async (transferPub: string, nonce: string) =>
  b64u.encode(await H('commit', bytesOf(transferPub, 32), bytesOf(nonce, 32)));
export async function approvalCode(
  transferPub: string,
  deviceNonce: string,
  approverNonce: string,
) {
  const h = await H(
    'code',
    bytesOf(transferPub, 32),
    bytesOf(deviceNonce, 32),
    bytesOf(approverNonce, 32),
  );
  return String(new DataView(h.buffer).getUint32(0) % 10000).padStart(4, '0');
}
export async function sealKeyring(
  keyring: Keyring,
  deviceId: string,
  transferPub: string,
): Promise<SealedEnvelope> {
  const keys = await keyringKeys(keyring);
  const box = bytesOf(transferPub, 32);
  return seal({
    payload: { ...keyring },
    ctx: { t: 'keyring', account: keyring.account, device: deviceId },
    signer: keys.identity,
    to: [{ kid: await kid(box), box: transferPub }],
  });
}
/** Decrypts, then verifies the signature with the identity key inside the keyring. */
export async function openKeyring(
  env: SealedEnvelope,
  transfer: Opener,
  deviceId: string,
  account?: string,
): Promise<Keyring> {
  const head = await checkEnvelope(env);
  const keyring = checkKeyring(
    (await decryptPayload(env, head, await unwrapKey(env, head, [transfer]))) as unknown as Keyring,
  );
  const keys = await keyringKeys(keyring);
  if (env.from !== keys.signerKid) fail('Keyring not signed by its identity.');
  await verifySig(env, head, keys.identity.signPub);
  checkCtx(env.ctx, { t: 'keyring', account: account ?? keyring.account, device: deviceId });
  if (env.ctx.account !== keyring.account) fail('Context mismatch: account.');
  return keyring;
}
