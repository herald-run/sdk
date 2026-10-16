import { expect, it } from 'vitest';
import { b64u } from './bytes';
import {
  accountStatement,
  approvalCode,
  approvalNonce,
  certify,
  createKeyring,
  deviceCommit,
  fingerprint,
  formatToken,
  keyringKeys,
  keySet,
  openKeyring,
  parseRecoveryKey,
  parseToken,
  prfSalt,
  recoveryKey,
  seal,
  sealKeyring,
  signReceiver,
  transferKey,
  unwrapKeyring,
  verifyAccount,
  verifyCertificate,
  verifyReceiver,
  wrapKeyring,
} from './index';
const account = 'acct-1';
const keyring = createKeyring(account);
const keys = await keyringKeys(keyring);
const fp = await fingerprint(keys.identity.signPub);
it('publishes and verifies the account statement under the pinned fingerprint', async () => {
  const statement = await accountStatement(keyring);
  expect(statement.statement.inbox).toBe(keys.inbox[0].boxPub);
  expect((await verifyAccount(statement, fp)).inboxKid).toBe(keys.inboxKid);
  const other = await fingerprint((await keyringKeys(createKeyring(account))).identity.signPub);
  await expect(verifyAccount(statement, other)).rejects.toThrow('fingerprint mismatch');
  await expect(verifyAccount(statement, fp, 'acct-2')).rejects.toThrow('Account mismatch');
  const moved = { ...statement, statement: { ...statement.statement, account: 'acct-2' } };
  await expect(verifyAccount(moved, fp)).rejects.toThrow('Bad statement signature');
});
it('certifies integration keys', async () => {
  const set = await keySet();
  const cert = await certify(keyring, { sign: set.signPub, box: set.boxPub });
  expect(await verifyCertificate(cert, keys.identity.signPub, account)).toEqual({
    kid: set.kid,
    sign: set.signPub,
    box: set.boxPub,
  });
  const swapped = { ...cert, certificate: { ...cert.certificate, box: keys.inbox[0].boxPub } };
  await expect(verifyCertificate(cert, keys.identity.signPub, 'acct-2')).rejects.toThrow(
    'account mismatch',
  );
  await expect(verifyCertificate(swapped, keys.identity.signPub, account)).rejects.toThrow(
    'kid mismatch',
  );
  await expect(verifyCertificate(cert, set.signPub, account)).rejects.toThrow(
    'Bad certificate signature',
  );
});
it('signs secret receiver keys', async () => {
  const claim = { message: 'm', claimId: 'c', publicKey: { kty: 'RSA', n: 'AQAB', ext: true } };
  const sig = await signReceiver(keyring, claim);
  await verifyReceiver(sig, keys.identity.signPub, claim);
  await expect(
    verifyReceiver(sig, keys.identity.signPub, { ...claim, claimId: 'd' }),
  ).rejects.toThrow('Bad receiver');
});
it('wraps the keyring for passkeys and recovery keys', async () => {
  expect((await prfSalt()).length).toBe(32);
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = b64u.encode(Uint8Array.of(1, 2, 3));
  const passkey = await wrapKeyring(keyring, { kind: 'prf', prf, credentialId });
  expect(await unwrapKeyring(passkey, prf)).toEqual(keyring);
  await expect(unwrapKeyring(passkey, new Uint8Array(32))).rejects.toThrow('Decryption failed');
  await expect(unwrapKeyring({ ...passkey, credentialId: 'AQID' + 'BA' }, prf)).rejects.toThrow(
    'Decryption failed',
  );
  const recovery = recoveryKey();
  expect(recovery.text).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){12}[0-9A-HJKMNP-TV-Z]{4}$/);
  const typed = recovery.text
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/0/g, 'o')
    .replace(/1/g, 'l');
  expect(parseRecoveryKey(typed)).toEqual(recovery.bytes);
  const wrapped = await wrapKeyring(keyring, { kind: 'recovery', recovery: recovery.bytes });
  expect(wrapped.credentialId).toBeUndefined();
  expect(await unwrapKeyring(wrapped, parseRecoveryKey(recovery.text))).toEqual(keyring);
  await expect(unwrapKeyring(wrapped, recoveryKey().bytes)).rejects.toThrow('Decryption failed');
  await expect(
    unwrapKeyring({ ...wrapped, kind: 'prf', credentialId }, recovery.bytes),
  ).rejects.toThrow();
  for (const bad of [
    recovery.text.slice(1),
    recovery.text + '0',
    recovery.text.replace(/.$/, 'U'),
    recovery.text.replace(/.$/, 'Z'),
  ])
    expect(() => parseRecoveryKey(bad), bad).toThrow('Invalid recovery key');
});
it('approves a locked device through commitment, code and a sealed keyring', async () => {
  const transfer = await transferKey();
  const [nD, nA] = [approvalNonce(), approvalNonce()];
  const commit = await deviceCommit(transfer.boxPub, nD);
  expect(await deviceCommit(transfer.boxPub, nD)).toBe(commit);
  expect(await deviceCommit(transfer.boxPub, nA)).not.toBe(commit);
  const code = await approvalCode(transfer.boxPub, nD, nA);
  expect(code).toMatch(/^\d{4}$/);
  expect(await approvalCode(transfer.boxPub, nD, nA)).toBe(code);
  const env = await sealKeyring(keyring, 'device-1', transfer.boxPub);
  expect(await openKeyring(env, transfer, 'device-1', account)).toEqual(keyring);
  expect((await transferKey(transfer.seed)).boxPub).toBe(transfer.boxPub);
  await expect(openKeyring(env, transfer, 'device-2')).rejects.toThrow('Context mismatch: device');
  await expect(openKeyring(env, transfer, 'device-1', 'acct-2')).rejects.toThrow(
    'Context mismatch: account',
  );
  await expect(openKeyring(env, await transferKey(), 'device-1')).rejects.toThrow('No recipient');
  await expect(
    openKeyring(
      { ...env, sig: env.sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) },
      transfer,
      'device-1',
    ),
  ).rejects.toThrow('Bad signature');
  const other = await keyringKeys(createKeyring(account));
  const ctx = { t: 'keyring', account, device: 'device-1' };
  const forged = await seal({
    payload: { ...keyring },
    ctx,
    signer: other.identity,
    to: [{ kid: transfer.kid, box: transfer.boxPub }],
  });
  await expect(openKeyring(forged, transfer, 'device-1')).rejects.toThrow(
    'not signed by its identity',
  );
});
it('parses and formats end-to-end tokens', async () => {
  const set = await keySet();
  const token = formatToken('hdr_abc', set.seed, fp);
  expect(parseToken(token)).toEqual({ auth: 'hdr_abc', seed: set.seed, fingerprint: fp });
  expect(parseToken(' hdr_legacy\n')).toEqual({ auth: 'hdr_legacy' });
  for (const bad of [
    '',
    'hdr_a.b',
    `hdr_a.${set.seed}.${fp}.x`,
    `hdr_a.${set.seed}.AAAA`,
    `.${set.seed}.${fp}`,
  ])
    expect(() => parseToken(bad), bad).toThrow();
  expect(() => formatToken('a.b', set.seed, fp)).toThrow('Malformed token');
});
