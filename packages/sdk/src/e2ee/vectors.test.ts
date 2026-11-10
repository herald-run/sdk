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
it('opens the chat vectors and binds the room to its members', async () => {
  const v = committed;
  const { members, nonce, room, envelopes, certificate } = v.chat;
  expect(await e2ee.roomId([...members].reverse(), nonce)).toBe(room);
  expect(await e2ee.roomId(members, nonce + 'x')).not.toBe(room);
  expect(e2ee.pairKey([...members].reverse())).toBe(v.chat.pairKey);
  const keys = await e2ee.keyringKeys(v.keyring.value);
  const info = await e2ee.verifyAccount(
    v.statement,
    v.keyring.fingerprint,
    v.keyring.value.account,
  );
  const checked = await e2ee.verifyCertificate(certificate, info.identity, v.keyring.value.account);
  const integration = await e2ee.keySet(
    v.keySets.find((s: { name: string }) => s.name === 'integration').seed,
  );
  expect(checked.sign).toBe(integration.signPub);
  for (const c of envelopes) {
    const got = await e2ee.open(c.envelope, {
      recipients: [keys.inbox[0]],
      signers: (kid: string) => (kid === integration.kid ? integration.signPub : undefined),
      expect: c.envelope.ctx,
    });
    expect(got).toEqual({ v: 1, ...c.payload });
  }
});
it('verifies the group head chain vectors', async () => {
  const v = committed;
  const { creator, room, chain, tip } = v.chat.group;
  expect(await e2ee.groupRoomId(creator, v.chat.nonce)).toBe(room);
  const info = await e2ee.verifyAccount(
    v.statement,
    v.keyring.fingerprint,
    v.keyring.value.account,
  );
  const keys = {
    account: v.keyring.value.account,
    verifier: (p: string) =>
      p === creator ? { kid: chain[0].from, sign: info.identity } : undefined,
  };
  const nonce = v.chat.nonce;
  expect(await e2ee.verifyHeadChain(keys, { id: room, nonce }, chain)).toBe(tip);
  const forged = [chain[0], { ...chain[1], head: { ...chain[1].head, owners: ['h:x'] } }];
  await expect(e2ee.verifyHeadChain(keys, { id: room, nonce }, forged)).rejects.toThrow();
});
it('caps chat at 64 recipients and everything else at 16', async () => {
  const set = await e2ee.keySet(committed.keySets[0].seed);
  const ctx = (t: string) =>
    t === 'chat'
      ? e2ee.chatContext({
          account: 'acct',
          room: 'r',
          id: '00000000-0000-4000-8000-000000000000',
          audience: 'all',
          sub: '',
          head: 'r',
        })
      : { t, account: 'acct', id: '00000000-0000-4000-8000-000000000000' };
  const to = (n: number) => Array.from({ length: n }, () => ({ kid: set.kid, box: set.boxPub }));
  const send = (t: string, n: number) =>
    e2ee.seal({ payload: {}, ctx: ctx(t), signer: set, to: to(n) });
  await expect(send('message', 17)).rejects.toThrow('1 to 16');
  await expect(send('chat', 65)).rejects.toThrow('1 to 64');
  expect((await send('chat', 64)).to).toHaveLength(64);
});
it('opens every committed vector', async () => {
  const v = committed;
  const keys = await e2ee.keyringKeys(v.keyring.value);
  expect([keys.signerKid, keys.inboxKid]).toEqual([v.keyring.signerKid, v.keyring.inboxKid]);
  expect(e2ee.safetyCode(v.keyring.fingerprint)).toBe(v.keyring.safetyCode);
  expect(v.keyring.safetyCode).toMatch(/^\d{5}( \d{5}){5}$/);
  expect(e2ee.safetyCode('AAAAAAAAAAAAAAAAAAAAAA')).toBe('00000 00000 00000 00000 00000 00000');
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
it('verifies and opens the workspace vectors', async () => {
  const w = committed.workspace;
  const sets: Record<string, e2ee.KeySet> = {};
  for (const s of committed.keySets) sets[s.name] = await e2ee.keySet(s.seed);
  const ws = await e2ee.verifyWorkspace({ chain: w.chain, roster: w.roster }, w.fingerprint);
  expect(ws.pin).toEqual(w.pin);
  expect(e2ee.safetyCode(w.fingerprint)).toBe(w.safetyCode);
  for (const [i, s] of w.identities.entries()) {
    const id = await e2ee.workspaceIdentity(s.seed);
    expect([id.kid, id.boxKid, id.signPub, id.boxPub]).toEqual([
      s.kid,
      s.boxKid,
      s.signPub,
      s.boxPub,
    ]);
    expect(w.chain[i].statement.identity).toBe(s.signPub);
  }
  const recovery = await e2ee.recoveryKeySet(e2ee.parseRecoveryKey(w.recovery.text));
  expect([recovery.kid, recovery.boxPub]).toEqual([w.recovery.kid, w.recovery.boxPub]);
  expect(b64u.encode(e2ee.parseRecoveryKey(w.recovery.text))).toBe(w.seeds.recovery);
  const ops = [
    await e2ee.teamKeySet(w.seeds.ops1, ws.root),
    await e2ee.teamKeySet(w.seeds.ops2, ws.root),
  ];
  const all = await e2ee.teamKeySet(w.seeds.all1, ws.root);
  expect({ ops: ops.map((k) => k.kid), all: [all.kid] }).toEqual(w.teams);
  expect(ws.teams.get('team-ops')!.kid).toBe(ops[1].kid);
  const certs = new Map<string, e2ee.CheckedCertificate>();
  for (const c of w.certificates) {
    const checked = await e2ee.verifyWorkspaceCertificate(c.certificate, ws);
    certs.set(checked.kid, checked);
  }
  expect([...certs.values()].map((c) => [c.teams, c.by])).toEqual([
    [['team-ops'], 'user-ana'],
    [['team-all', 'team-ops'], undefined],
  ]);
  const ana = await e2ee.keyringKeys(w.keyrings.ana);
  const team = await e2ee.openTeamKey(w.wraps[0].envelope, {
    ws,
    recipients: ana.inbox,
    ...w.wraps[0].ctx,
  });
  expect(team.kid).toBe(ops[1].kid);
  for (const opener of [recovery]) {
    const viaRecovery = await e2ee.openTeamKey(w.wraps[0].envelope, {
      ws,
      recipients: [opener],
      ...w.wraps[0].ctx,
    });
    expect(viaRecovery.kid).toBe(ops[1].kid);
  }
  const head = await e2ee.openWorkspaceKey(w.wraps[1].envelope, {
    ws,
    recipients: ana.inbox,
    ...w.wraps[1].ctx,
  });
  expect(head.signPub).toBe(ws.head.identity);
  const openers: Record<string, e2ee.Opener> = {
    ops: ops[1],
    all,
    integration: sets.integration,
    destination: sets.destination,
  };
  const signers = (env: SealedEnvelope) => (from: string) =>
    e2ee.workspaceSigner(ws, certs, env.ctx, from);
  for (const c of w.envelopes)
    for (const name of c.to)
      expect(
        await e2ee.open(c.envelope, {
          recipients: [openers[name]],
          signers: signers(c.envelope),
          expect: c.envelope.ctx,
        }),
      ).toEqual({ v: 1, ...c.payload });
  for (const c of w.negative) {
    const run = async () => {
      if (c.kind === 'envelope')
        return e2ee.open(c.envelope, {
          recipients: [openers.ops],
          signers: signers(c.envelope),
          expect: c.envelope.ctx,
        });
      if (c.kind === 'workspace')
        return e2ee.verifyWorkspace({ chain: c.chain, roster: c.roster }, w.fingerprint, {
          pin: c.pin,
        });
      if (c.kind === 'certificate') return e2ee.verifyWorkspaceCertificate(c.certificate, ws);
      if (c.kind === 'teamkey')
        return e2ee.openTeamKey(c.envelope, { ws, recipients: ana.inbox, ...c.ctx });
      if (c.kind === 'wskey')
        return e2ee.openWorkspaceKey(c.envelope, { ws, recipients: ana.inbox, ...c.ctx });
      if (c.kind === 'join') return e2ee.verifyJoinProof(b64u.decode(c.secret), c.claim, c.proof);
      if (c.kind === 'receiver') {
        const member = e2ee.teamMember(ws, c.claim.member, c.team);
        return e2ee.verifyReceiver(c.sig, member.identity, c.claim);
      }
      return e2ee.checkCtx(c.ctx);
    };
    await expect(run(), c.name).rejects.toThrow(c.error);
  }
  const secret = b64u.decode(w.join.secret);
  expect(b64u.encode(await e2ee.inviteSecret(w.seeds.identity1, w.join.claim.invite))).toBe(
    w.join.secret,
  );
  await e2ee.verifyJoinProof(secret, w.join.claim, w.join.proof);
  expect(e2ee.inviteFragment(secret, w.fingerprint)).toBe(w.join.fragment);
  const parsed = e2ee.parseInviteFragment('#' + w.join.fragment);
  expect([b64u.encode(parsed.secret), parsed.fingerprint]).toEqual([w.join.secret, w.fingerprint]);
  expect(() => e2ee.parseInviteFragment(w.join.secret)).toThrow('Malformed invite link');
  expect([...ws.members.values()].map((m) => m.name)).toEqual(['Ana', 'Ben']);
  await expect(
    e2ee.verifyJoinProof(secret, { ...w.join.claim, user: 'user-eve' }, w.join.proof),
  ).rejects.toThrow('Bad join proof');
  await e2ee.verifyReceiver(w.receiver.sig, ana.identity.signPub, w.receiver.claim);
});
