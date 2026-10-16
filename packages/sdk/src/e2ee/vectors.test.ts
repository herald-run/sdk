import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { filePattern, generateVectors } from '../../fixtures/e2ee-vectors';
import type { SealedEnvelope } from '../schema/e2ee';
import { b64u } from './bytes';
import * as e2ee from './index';
const path = new URL('../../fixtures/e2ee-vectors.json', import.meta.url);
const committed = JSON.parse(readFileSync(path, 'utf8'));
it('the committed vectors are current', async () => {
  const generated = await generateVectors();
  if (process.env.E2EE_VECTORS === 'write')
    writeFileSync(path, JSON.stringify(generated, null, 2) + '\n');
  else expect(JSON.parse(JSON.stringify(generated))).toEqual(committed);
});
it('opens every committed vector', async () => {
  const v = committed;
  const keys = await e2ee.keyringKeys(v.keyring.value);
  expect([keys.signerKid, keys.inboxKid]).toEqual([v.keyring.signerKid, v.keyring.inboxKid]);
  const info = await e2ee.verifyAccount(
    v.statement,
    v.keyring.fingerprint,
    v.keyring.value.account,
  );
  const sets: Record<string, e2ee.KeySet> = {};
  for (const s of v.keySets) sets[s.name] = await e2ee.keySet(s.seed);
  const signPubs: Record<string, string> = { account: info.identity };
  for (const c of v.certificates)
    signPubs[c.name] = (
      await e2ee.verifyCertificate(c.certificate, info.identity, v.keyring.value.account)
    ).sign;
  const kids: Record<string, string> = {
    account: info.signerKid,
    integration: sets.integration.kid,
    destination: sets.destination.kid,
  };
  const openers: Record<string, e2ee.Opener> = { inbox: keys.inbox[0], ...sets };
  const signers = (names: string[]) => (kid: string) =>
    names.map((n) => kid === kids[n] && signPubs[n]).find(Boolean) || undefined;
  const all = ['account', 'integration', 'destination'];
  for (const c of v.envelopes)
    for (const name of c.to)
      expect(
        await e2ee.open(c.envelope, {
          recipients: [openers[name]],
          signers: signers(all),
          expect: c.envelope.ctx,
        }),
      ).toEqual({ v: 1, ...c.payload });
  for (const c of v.negative)
    await expect(
      e2ee.open(c.envelope, {
        recipients: c.recipients.map((n: string) => openers[n]),
        signers: signers(c.trusted),
        expect: c.expect,
      }),
      c.name,
    ).rejects.toThrow(c.error);
  const granted: SealedEnvelope = { ...v.envelopes[0].envelope, to: [v.grant.recipient] };
  expect(
    await e2ee.open(granted, {
      recipients: [sets.destination],
      signers: signers(all),
      expect: granted.ctx,
    }),
  ).toEqual({ v: 1, ...v.envelopes[0].payload });
  for (const f of v.files.filter((f: { sealed?: string }) => f.sealed)) {
    const plain = new Uint8Array(
      await new Response(e2ee.openFile(f.key, b64u.decode(f.sealed))).arrayBuffer(),
    );
    expect(plain).toEqual(filePattern(f.size));
  }
  expect(b64u.encode(e2ee.parseRecoveryKey(v.recovery.text))).toBe(v.backups[1].secret);
  for (const b of v.backups)
    expect(await e2ee.unwrapKeyring(b.wrapped, b64u.decode(b.secret))).toEqual(v.keyring.value);
  const transfer = await e2ee.transferKey(v.approval.transfer.seed);
  expect(await e2ee.openKeyring(v.approval.envelope, transfer, v.approval.device)).toEqual(
    v.keyring.value,
  );
  expect(await e2ee.deviceCommit(transfer.boxPub, v.approval.deviceNonce)).toBe(v.approval.commit);
  await e2ee.verifyReceiver(v.receiver.sig, info.identity, v.receiver.claim);
});
