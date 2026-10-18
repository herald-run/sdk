/**
 * Generates `e2ee-vectors.json`: fixed randomness in, every output recorded. Each case lists the
 * random draws it consumed, in order, so other implementations can reproduce the exact bytes.
 * Regenerate with `pnpm vectors` from the repository root.
 */
import { createHash } from 'node:crypto';
import { b64u, hex } from '../src/e2ee/bytes';
import { deriveKeyPair, hpkeSeal } from '../src/e2ee/hpke';
import * as e2ee from '../src/e2ee/index';
import { setTestHooks } from '../src/e2ee/random';
import type { SealedEnvelope } from '../src/schema/e2ee';
export const NOW = '2026-01-01T00:00:00.000Z';
const ACCOUNT = 'acct-vectors';
const ID = '0b7f8e2a-4c1d-4e5f-9a6b-3c2d1e0f9a8b';
const TASK_ID = '5d1c2b3a-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
/** File plaintext: byte i is (i * 7) % 251. */
export const filePattern = (size: number) =>
  Uint8Array.from({ length: size }, (_, i) => (i * 7) % 251);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer());
function flip(text: string, index = 0) {
  const bytes = b64u.decode(text);
  bytes[index] ^= 1;
  return b64u.encode(bytes);
}
export async function generateVectors() {
  let counter = 0;
  let draws: string[] = [];
  const random = (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 32)
      out.set(
        createHash('sha256')
          .update(`herald e2ee vectors ${counter++}`)
          .digest()
          .subarray(0, length - i),
        i,
      );
    draws.push(b64u.encode(out));
    return out;
  };
  const take = () => [draws, (draws = [])][0];
  setTestHooks({ random, now: () => NOW });
  try {
    const rfc = {
      aead: 1,
      info: '4f6465206f6e2061204772656369616e2055726e',
      ikmE: '7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234',
      ikmR: '6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037',
      pkR: '3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d',
      aad: '436f756e742d30',
      pt: '4265617574792069732074727574682c20747275746820626561757479',
      enc: '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431',
      ct: 'f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a',
    };
    const recipient = await deriveKeyPair(hex(rfc.ikmR));
    setTestHooks({ random: () => hex(rfc.ikmE), now: () => NOW });
    const own = await hpkeSeal(recipient.pub, hex(rfc.info), hex(rfc.aad), hex(rfc.pt), 2);
    setTestHooks({ random, now: () => NOW });
    const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
    const hpke = [rfc, { ...rfc, aead: 2, enc: toHex(own.enc), ct: toHex(own.ct) }];

    const canon = [
      {
        a: 1,
        Z: [true, false, null],
        é: 'é',
        '\u{1f600}': 2,
        '': 3,
        nested: { b: -0, a: 9007199254740991 },
      },
      ['\u0000\u001f\b\t\n\f\r"\\/', ' \u007f', '\ud800', 'x\udc00y'],
      [0.5, 1e-7, -1.25e-10, 123456.789, 1e-6, 0.000001234, -0, 100],
      {},
      [],
    ].map((value) => ({ value, canon: e2ee.canon(value) }));
    const hash = [];
    for (const [label, parts] of [
      ['file', []],
      ['wrap', ['cHJm', 'AQID']],
    ] as const)
      hash.push({
        label,
        parts,
        digest: b64u.encode(await e2ee.H(label, ...parts.map(b64u.decode))),
      });

    const keyring = e2ee.createKeyring(ACCOUNT);
    const keyringRandom = take();
    const keys = await e2ee.keyringKeys(keyring);
    const sets = {
      integration: await e2ee.keySet(),
      destination: await e2ee.keySet(),
      outsider: await e2ee.keySet(),
    };
    take();
    const keySets = Object.entries(sets).map(([name, s]) => ({
      name,
      seed: s.seed,
      kid: s.kid,
      signPub: s.signPub,
      boxPub: s.boxPub,
    }));
    const statement = await e2ee.accountStatement(keyring);
    const certificates = [];
    for (const name of ['integration', 'destination'] as const)
      certificates.push({
        name,
        certificate: await e2ee.certify(keyring, {
          sign: sets[name].signPub,
          box: sets[name].boxPub,
        }),
      });

    const signers = {
      account: keys.identity,
      integration: sets.integration,
      destination: sets.destination,
    };
    const recipients = {
      inbox: { kid: keys.inboxKid, box: keys.inbox[0].boxPub },
      integration: { kid: sets.integration.kid, box: sets.integration.boxPub },
      destination: { kid: sets.destination.kid, box: sets.destination.boxPub },
    };
    type Case = {
      name: string;
      signer: keyof typeof signers;
      to: (keyof typeof recipients)[];
      ctx: e2ee.Ctx;
      payload: e2ee.Payload;
    };
    const message = {
      title: 'Deploy to production? ✓',
      body: 'Ünïcode, emoji \u{1f680}, numbers',
      kind: 'message',
      fields: [
        { id: 'ratio', value: 0.25 },
        { id: 'tiny', value: 1e-7 },
      ],
      blocks: [],
      actions: [{ id: 'yes', label: 'Yes' }],
    };
    const cases: Case[] = [
      {
        name: 'message',
        signer: 'integration',
        to: ['inbox', 'integration'],
        ctx: { t: 'message', account: ACCOUNT, id: ID },
        payload: message,
      },
      {
        name: 'response',
        signer: 'account',
        to: ['inbox', 'integration'],
        ctx: { t: 'response', account: ACCOUNT, message: ID, request: '' },
        payload: { values: { ok: true }, actionId: 'yes' },
      },
      {
        name: 'task',
        signer: 'account',
        to: ['inbox', 'destination'],
        ctx: { t: 'task', account: ACCOUNT, id: TASK_ID, destination: ID, type: 'deploy' },
        payload: { values: { branch: 'main' }, session: null },
      },
      {
        name: 'log',
        signer: 'integration',
        to: ['inbox', 'integration'],
        ctx: { t: 'log', account: ACCOUNT, task: ID, seq: 7 },
        payload: { text: 'line one\nline two' },
      },
      {
        name: 'result',
        signer: 'integration',
        to: ['inbox', 'integration'],
        ctx: { t: 'result', account: ACCOUNT, task: ID },
        payload: { error: null },
      },
      {
        name: 'secret',
        signer: 'account',
        to: ['integration'],
        ctx: { t: 'secret', account: ACCOUNT, message: ID, field: 'password' },
        payload: { value: 'hunter2' },
      },
    ];
    const envelopes: (Case & { random: string[]; envelope: SealedEnvelope })[] = [];
    for (const c of cases) {
      if (c.name === 'response') c.ctx.request = await e2ee.envelopeDigest(envelopes[0].envelope);
      const envelope = await e2ee.seal({
        payload: c.payload,
        ctx: c.ctx,
        signer: signers[c.signer],
        to: c.to.map((n) => recipients[n]),
      });
      envelopes.push({ ...c, random: take(), envelope });
    }
    const env = envelopes[0].envelope;
    const expect = env.ctx;
    const all = ['account', 'integration', 'destination'];
    const negative = [
      { name: 'tampered ct', envelope: { ...env, ct: flip(env.ct) }, error: 'Bad signature' },
      { name: 'tampered iv', envelope: { ...env, iv: flip(env.iv) }, error: 'Bad signature' },
      {
        name: 'tampered head',
        envelope: { ...env, ctx: { ...env.ctx, id: TASK_ID } },
        expect: { t: 'message', account: ACCOUNT },
        error: 'Bad signature',
      },
      {
        name: 'replayed under another id',
        envelope: env,
        expect: { ...expect, id: TASK_ID },
        error: 'Context mismatch: id',
      },
      { name: 'tampered sig', envelope: { ...env, sig: flip(env.sig, 5) }, error: 'Bad signature' },
      {
        name: 'swapped signer',
        envelope: { ...env, from: keys.signerKid },
        error: 'Bad signature',
      },
      {
        name: 'tampered to entry',
        envelope: { ...env, to: [{ ...env.to[0], key: flip(env.to[0].key) }, env.to[1]] },
        error: 'Decryption failed',
      },
      {
        name: 'relabelled to entry',
        envelope: { ...env, to: [{ ...env.to[1], kid: env.to[0].kid }] },
        error: 'Decryption failed',
      },
      {
        name: 'wrong recipient',
        envelope: env,
        recipients: ['outsider'],
        error: 'No recipient entry',
      },
      {
        name: 'wrong account expected',
        envelope: env,
        expect: { ...expect, account: 'acct-other' },
        error: 'Context mismatch: account',
      },
      {
        name: 'wrong type expected',
        envelope: env,
        expect: { ...expect, t: 'log' },
        error: 'Context mismatch: t',
      },
      {
        name: 'unknown version',
        envelope: { ...env, v: 2 },
        error: 'Unsupported envelope version',
      },
      { name: 'untrusted signer', envelope: env, trusted: ['account'], error: 'Untrusted signer' },
    ].map((c) => ({ recipients: ['inbox'], trusted: all, expect, ...c }));

    const cek = await e2ee.openKey(env, keys.inbox);
    const grantRecipient = await e2ee.grant(env, cek, recipients.destination);
    const grant = {
      envelope: 'message',
      to: 'destination',
      random: take(),
      recipient: grantRecipient,
    };
    const idempotency = [
      {
        name: 'integration',
        payload: message,
        key: 'retry-key-1',
        digest: await e2ee.idempotencyDigest(sets.integration.seed, message, 'retry-key-1'),
      },
      {
        name: 'integration',
        payload: message,
        key: 'retry-key-2',
        digest: await e2ee.idempotencyDigest(sets.integration.seed, message, 'retry-key-2'),
      },
    ];

    const files = [];
    for (const size of [0, 100, 65537]) {
      const key = e2ee.fileKey();
      const sealed = await read(e2ee.sealFile(key, filePattern(size)));
      const [keyDraw, ...rest] = take();
      files.push({
        key: keyDraw,
        size,
        random: rest,
        sha256: sha(sealed),
        ...(size <= 100 ? { sealed: b64u.encode(sealed) } : {}),
      });
      if (key !== keyDraw) throw new Error('file key draw');
    }

    const recoveryKey = e2ee.recoveryKey();
    const recovery = { random: take(), text: recoveryKey.text };
    const prf = b64u.encode(random(32));
    take();
    const credentialId = 'Y3JlZGVudGlhbC1pZA';
    const backups = [
      {
        kind: 'prf',
        secret: prf,
        wrapped: await e2ee.wrapKeyring(keyring, {
          kind: 'prf',
          prf: b64u.decode(prf),
          credentialId,
        }),
        random: take(),
      },
      {
        kind: 'recovery',
        secret: b64u.encode(recoveryKey.bytes),
        wrapped: await e2ee.wrapKeyring(keyring, { kind: 'recovery', recovery: recoveryKey.bytes }),
        random: take(),
      },
    ];

    const transfer = await e2ee.transferKey();
    const deviceNonce = e2ee.approvalNonce();
    const approverNonce = e2ee.approvalNonce();
    take();
    const sealedKeyring = await e2ee.sealKeyring(keyring, ID, transfer.boxPub);
    const approval = {
      transfer: { seed: transfer.seed, kid: transfer.kid, boxPub: transfer.boxPub },
      deviceNonce,
      approverNonce,
      commit: await e2ee.deviceCommit(transfer.boxPub, deviceNonce),
      code: await e2ee.approvalCode(transfer.boxPub, deviceNonce, approverNonce),
      device: ID,
      random: take(),
      envelope: sealedKeyring,
    };
    const claim = {
      message: ID,
      claimId: 'claim-1',
      publicKey: { kty: 'RSA', e: 'AQAB', n: 'sGVy', ext: true, key_ops: ['encrypt'] },
    };
    const receiver = { claim, sig: await e2ee.signReceiver(keyring, claim) };
    const fingerprint = await e2ee.fingerprint(keys.identity.signPub);
    const token = e2ee.formatToken('hdr_test-only', sets.integration.seed, fingerprint);
    const tokens = [
      { token, parsed: e2ee.parseToken(token) },
      { token: 'hdr_legacy-only', parsed: e2ee.parseToken('hdr_legacy-only') },
    ];
    const workspace = await workspaceVectors(random, take, { sets, flip });
    return {
      _comment:
        'Test-only keys and deterministic randomness. Each case lists its random draws in order.',
      now: NOW,
      canon,
      hash,
      hpke,
      keyring: {
        random: keyringRandom,
        value: keyring,
        signerKid: keys.signerKid,
        inboxKid: keys.inboxKid,
        fingerprint,
        safetyCode: e2ee.safetyCode(fingerprint),
      },
      keySets,
      statement,
      certificates,
      envelopes,
      negative,
      grant,
      idempotency,
      files,
      recovery,
      backups,
      approval,
      receiver,
      tokens,
      workspace,
    };
  } finally {
    setTestHooks();
  }
}

const WS = 'ws_vectors';
const OPS = 'team-ops';
const ALL = 'team-all';
/**
 * Team workspace vectors: a two-link chain, a roster, certificates, key wraps, team envelopes and
 * the checks that must fail. Seeds are listed so other implementations rebuild every key.
 */
async function workspaceVectors(
  random: (length: number) => Uint8Array,
  take: () => string[],
  ctx: {
    sets: Record<'integration' | 'destination' | 'outsider', e2ee.KeySet>;
    flip: (text: string, index?: number) => string;
  },
) {
  const { sets } = ctx;
  const seed = () => b64u.encode(random(32));
  const seeds = {
    identity0: seed(),
    identity1: seed(),
    forked: seed(),
    recovery: seed(),
    ops1: seed(),
    ops2: seed(),
    all1: seed(),
    forged: seed(),
  };
  const users = { ana: 'user-ana', ben: 'user-ben', eve: 'user-eve' };
  const keyrings = {
    ana: e2ee.createKeyring(users.ana),
    ben: e2ee.createKeyring(users.ben),
    eve: e2ee.createKeyring(users.eve),
  };
  take();
  const id0 = await e2ee.workspaceIdentity(seeds.identity0);
  const id1 = await e2ee.workspaceIdentity(seeds.identity1);
  const recovery = await e2ee.recoveryKeySet(b64u.decode(seeds.recovery));
  const link0 = await e2ee.workspaceLink({
    workspace: WS,
    identity: id0,
    recovery: recovery.boxPub,
  });
  const prev = { link: link0, identity: id0 };
  const link1 = await e2ee.workspaceLink({
    workspace: WS,
    identity: id1,
    recovery: recovery.boxPub,
    prev,
  });
  const chain = [link0, link1];
  const fp = await e2ee.fingerprint(id0.signPub);
  const team = async (s: string) => e2ee.teamKeySet(s, id0.signPub);
  const ops = [await team(seeds.ops1), await team(seeds.ops2)];
  const all = [await team(seeds.all1)];
  const people = {
    ana: await e2ee.keyringKeys(keyrings.ana),
    ben: await e2ee.keyringKeys(keyrings.ben),
    eve: await e2ee.keyringKeys(keyrings.eve),
  };
  const entry = (name: 'ana' | 'ben', caps: ('connect' | 'keys')[], teams: string[]) => ({
    user: users[name],
    identity: people[name].identity.signPub,
    inbox: people[name].inbox.at(-1)!.boxPub,
    caps,
    teams,
  });
  const members = [entry('ana', ['connect', 'keys'], [OPS, ALL]), entry('ben', [], [ALL])];
  const teams = [
    { id: OPS, slug: 'ops', keys: ops.map((k) => k.boxPub) },
    { id: ALL, slug: 'all', keys: all.map((k) => k.boxPub) },
  ];
  const roster = await e2ee.signRoster({ epoch: 2, members, teams, head: link1 }, id1);
  const ws = await e2ee.verifyWorkspace({ chain, roster }, fp);
  const memberCert = await e2ee.certifyWorkspace(
    {
      workspace: WS,
      keys: { sign: sets.integration.signPub, box: sets.integration.boxPub },
      teams: [OPS],
      epoch: 2,
      by: users.ana,
    },
    people.ana.identity,
  );
  const directCert = await e2ee.certifyWorkspace(
    {
      workspace: WS,
      keys: { sign: sets.destination.signPub, box: sets.destination.boxPub },
      teams: [ALL, OPS],
      epoch: 2,
    },
    id1,
  );
  const certificates = [
    { name: 'integration', certificate: memberCert },
    { name: 'destination', certificate: directCert },
  ];
  const wraps = [
    {
      name: 'teamkey',
      ctx: { team: OPS, kv: 2, member: users.ana },
      envelope: await e2ee.wrapTeamKey({
        ws,
        team: OPS,
        kv: 2,
        member: users.ana,
        seed: seeds.ops2,
        signer: id1,
      }),
      random: take(),
    },
    {
      name: 'wskey',
      ctx: { n: 1, member: users.ana },
      envelope: await e2ee.wrapWorkspaceKey({
        ws,
        n: 1,
        member: users.ana,
        seed: seeds.identity1,
        signer: id1,
      }),
      random: take(),
    },
  ];
  const ID = '7c1f2e3d-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
  const TASK = '2a3b4c5d-6e7f-4a8b-9c0d-e1f2a3b4c5d6';
  const DEST = '3b4c5d6e-7f8a-4b9c-8d0e-f1a2b3c4d5e6';
  const recipient = (k: { kid: string; boxPub: string }) => ({ kid: k.kid, box: k.boxPub });
  const signers = {
    integration: sets.integration,
    ana: people.ana.identity,
    ben: people.ben.identity,
    eve: people.eve.identity,
  };
  type Case = {
    name: string;
    signer: keyof typeof signers;
    to: string[];
    ctx: e2ee.Ctx;
    payload: e2ee.Payload;
  };
  const keys: Record<string, { kid: string; boxPub: string }> = {
    ops: ops[1],
    all: all[0],
    integration: sets.integration,
    destination: sets.destination,
  };
  const cases: Case[] = [
    {
      name: 'message',
      signer: 'integration',
      to: ['ops', 'integration'],
      ctx: { t: 'message', account: WS, id: ID, team: OPS },
      payload: {
        title: 'Restart the queue?',
        body: '',
        kind: 'form',
        fields: [],
        actions: [{ id: 'yes', label: 'Yes', values: {} }],
      },
    },
    {
      name: 'response',
      signer: 'ana',
      to: ['ops', 'integration'],
      ctx: { t: 'response', account: WS, message: ID, request: '', team: OPS, member: users.ana },
      payload: { values: {}, actionId: 'yes' },
    },
    {
      name: 'task',
      signer: 'ana',
      to: ['all', 'destination'],
      ctx: {
        t: 'task',
        account: WS,
        id: TASK,
        destination: DEST,
        type: 'deploy',
        team: ALL,
        member: users.ana,
      },
      payload: { values: { branch: 'main' }, session: null },
    },
  ];
  const envelopes: (Case & { random: string[]; envelope: SealedEnvelope })[] = [];
  for (const c of cases) {
    if (c.name === 'response') c.ctx.request = await e2ee.envelopeDigest(envelopes[0].envelope);
    const envelope = await e2ee.seal({
      payload: c.payload,
      ctx: c.ctx,
      signer: signers[c.signer],
      to: c.to.map((n) => recipient(keys[n])),
    });
    envelopes.push({ ...c, random: take(), envelope });
  }
  const forged = async (
    name: string,
    signer: keyof typeof signers,
    member: string,
    error: string,
  ) => ({
    name,
    kind: 'envelope',
    error,
    envelope: await e2ee.seal({
      payload: { values: {}, actionId: 'yes' },
      ctx: { ...envelopes[1].ctx, member },
      signer: signers[signer],
      to: [recipient(keys.ops), recipient(keys.integration)],
    }),
  });
  const forkLink = await e2ee.workspaceLink({
    workspace: WS,
    identity: await e2ee.workspaceIdentity(seeds.forked),
    recovery: recovery.boxPub,
    prev,
  });
  const oldRoster = await e2ee.signRoster({ epoch: 3, members, teams, head: link0 }, id0);
  const forgedTeam = await team(seeds.forged);
  const forgedWrap = await e2ee.seal({
    payload: { seed: seeds.forged },
    ctx: { t: 'teamkey', account: WS, team: OPS, kv: 2, member: users.ana },
    signer: id0,
    to: [{ kid: people.ana.inboxKid, box: people.ana.inbox[0].boxPub }],
  });
  const integrationCert = await e2ee.certifyWorkspace(
    {
      workspace: WS,
      keys: { sign: sets.outsider.signPub, box: sets.outsider.boxPub },
      teams: [OPS],
      epoch: 2,
      by: sets.integration.kid,
    },
    sets.integration,
  );
  const benCert = await e2ee.certifyWorkspace(
    {
      workspace: WS,
      keys: { sign: sets.outsider.signPub, box: sets.outsider.boxPub },
      teams: [ALL],
      epoch: 2,
      by: users.ben,
    },
    people.ben.identity,
  );
  const futureCert = await e2ee.certifyWorkspace(
    {
      workspace: WS,
      keys: { sign: sets.outsider.signPub, box: sets.outsider.boxPub },
      teams: [OPS],
      epoch: 3,
    },
    id1,
  );
  const oldCert = await e2ee.certifyWorkspace(
    {
      workspace: WS,
      keys: { sign: sets.outsider.signPub, box: sets.outsider.boxPub },
      teams: [OPS],
      epoch: 2,
    },
    id0,
  );
  const pin = ws.pin;
  const negative = [
    await forged('non-member signer', 'eve', users.eve, 'Not a member.'),
    await forged('member outside the team', 'ben', users.ben, 'Not a member of the team'),
    await forged('signer is not ctx.member', 'ben', users.ana, 'Untrusted signer'),
    {
      name: 'stale epoch',
      kind: 'workspace',
      chain,
      roster,
      pin: { ...pin, epoch: 3 },
      error: 'Stale roster epoch',
    },
    {
      name: 'same epoch, other roster',
      kind: 'workspace',
      chain,
      roster,
      pin: { ...pin, roster: ctx.flip(pin.roster) },
      error: 'Stale roster epoch',
    },
    {
      name: 'fork',
      kind: 'workspace',
      chain: [link0, forkLink],
      roster,
      pin,
      error: 'Workspace chain fork',
    },
    {
      name: 'rollback',
      kind: 'workspace',
      chain: [link0],
      roster: oldRoster,
      pin,
      error: 'Workspace chain rollback',
    },
    {
      name: 'roster from an old link',
      kind: 'workspace',
      chain,
      roster: oldRoster,
      error: 'Roster is not signed by the head',
    },
    {
      name: 'broken succession',
      kind: 'workspace',
      chain: [link0, { ...link1, prevSig: link1.sig }],
      roster,
      error: 'Bad workspace succession signature',
    },
    {
      name: 'wrong root',
      kind: 'workspace',
      chain: [link1],
      roster,
      error: 'Workspace fingerprint mismatch',
    },
    {
      name: 'depth-3 certificate',
      kind: 'certificate',
      certificate: integrationCert,
      error: 'Unknown certifier',
    },
    {
      name: 'member without connect',
      kind: 'certificate',
      certificate: benCert,
      error: 'may not connect',
    },
    {
      name: 'certificate newer than roster',
      kind: 'certificate',
      certificate: futureCert,
      error: 'Stale roster epoch',
    },
    {
      name: 'certificate from an old link',
      kind: 'certificate',
      certificate: oldCert,
      error: 'Bad certificate signature',
    },
    {
      name: 'forged team key',
      kind: 'teamkey',
      envelope: forgedWrap,
      ctx: { team: OPS, kv: 2, member: users.ana },
      error: 'Team key does not match the roster',
    },
    {
      name: 'personal ctx with team',
      kind: 'ctx',
      ctx: { t: 'message', account: 'acct-vectors', id: ID, team: OPS },
      error: 'Unexpected ctx.team',
    },
    {
      name: 'workspace ctx without team',
      kind: 'ctx',
      ctx: { t: 'message', account: WS, id: ID },
      error: 'Invalid ctx.team',
    },
    {
      name: 'personal teamkey',
      kind: 'ctx',
      ctx: { t: 'teamkey', account: 'acct-vectors' },
      error: 'Unknown context type',
    },
  ];
  if (forgedTeam.boxPub === ops[1].boxPub) throw new Error('forged key');
  take();
  const recoveryText = e2ee.recoveryKeyText(b64u.decode(seeds.recovery));
  const secret = await e2ee.inviteSecret(seeds.identity1, 'invite-1');
  const claim = {
    workspace: WS,
    invite: 'invite-1',
    user: users.ben,
    identity: people.ben.identity.signPub,
    inbox: people.ben.inbox[0].boxPub,
  };
  const receiverClaim = {
    message: ID,
    claimId: 'claim-ws',
    publicKey: { kty: 'RSA', e: 'AQAB', n: 'sGVy' },
    member: users.ana,
  };
  return {
    workspace: WS,
    fingerprint: fp,
    safetyCode: e2ee.safetyCode(fp),
    seeds,
    keyrings,
    identities: [id0, id1].map((k) => ({
      seed: k.seed,
      kid: k.kid,
      boxKid: k.boxKid,
      signPub: k.signPub,
      boxPub: k.boxPub,
    })),
    recovery: { text: recoveryText, kid: recovery.kid, boxPub: recovery.boxPub },
    teams: { ops: ops.map((k) => k.kid), all: all.map((k) => k.kid) },
    chain,
    roster,
    pin,
    certificates,
    wraps,
    envelopes,
    negative,
    join: { claim, secret: b64u.encode(secret), proof: await e2ee.joinProof(secret, claim) },
    receiver: { claim: receiverClaim, sig: await e2ee.signReceiver(keyrings.ana, receiverClaim) },
  };
}
