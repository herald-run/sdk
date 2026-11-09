import { expect, it } from 'vitest';
import * as e2ee from './index';
import type { KeySet } from './keys';
import type { VerifiedChain } from './workspace';

const account = 'ws_team';
const people = async (names: string[]) =>
  Object.fromEntries(await Promise.all(names.map(async (n) => [n, await e2ee.keySet()] as const)));
function keysFor(me: string, sets: Record<string, KeySet>, on = Object.keys(sets)): e2ee.ChatKeys {
  const set = sets[me]!;
  return {
    account,
    principal: me,
    signer: { kid: set.kid, signPriv: set.signPriv },
    openers: [set],
    recipient: (p) => (on.includes(p) ? { kid: sets[p]!.kid, box: sets[p]!.boxPub } : undefined),
    verifier: (p) => (on.includes(p) ? { kid: sets[p]!.kid, sign: sets[p]!.signPub } : undefined),
  };
}
async function link(sets: Record<string, KeySet>, by: string, head: e2ee.ChatHead) {
  const set = sets[by]!;
  return e2ee.signChatHead(
    { account, principal: by, signer: { kid: set.kid, signPriv: set.signPriv } },
    head,
  );
}

it('ties ownership to the current head when a recovered owner returns', async () => {
  const sets = await people(['h:ann', 'h:ben', 'h:cat']);
  const nonce = 'n'.repeat(22);
  const id = await e2ee.groupRoomId('h:ann', nonce);
  const room = { id, nonce };
  const members = ['h:ann', 'h:ben', 'h:cat'];
  const v1 = { room: id, version: 1, prev: '', owners: ['h:ann'], members, team: 't1' };
  const next = async (prev: e2ee.ChatHead, change: Partial<e2ee.ChatHead>) => ({
    ...prev,
    version: prev.version + 1,
    prev: await e2ee.headHash(prev),
    ...change,
  });
  const v2 = await next(v1, { owners: ['h:ben'] });
  const chain = [await link(sets, 'h:ann', v1), await link(sets, 'h:ben', v2)];
  const away = keysFor('h:ben', sets, ['h:ben', 'h:cat']);
  const tip = await e2ee.verifyHeadChain(away, room, chain);
  // A recovery head must make its signer the owner, never a former owner, and keeps the team.
  for (const bad of [
    await next(v1, { owners: ['h:cat'] }),
    await next(v1, { owners: ['h:ben', 'h:ann'] }),
    await next(v1, { owners: ['h:ben'], team: 't2' }),
  ])
    await expect(
      e2ee.verifyHeadChain(away, room, [chain[0]!, await link(sets, 'h:ben', bad)]),
    ).rejects.toThrow();
  // Ann is back: today's roster cannot vouch for the recovery, only this client's pin can.
  const back = keysFor('h:ben', sets);
  await expect(e2ee.verifyHeadChain(back, room, chain)).rejects.toThrow();
  expect(await e2ee.verifyHeadChain(back, room, chain, undefined, { version: 2, hash: tip })).toBe(
    tip,
  );
  await expect(
    e2ee.verifyHeadChain(back, room, chain, undefined, { version: 1, hash: chain[0]!.sig }),
  ).rejects.toThrow();
  // Ann signs nothing until a current owner makes her one.
  const v3 = await next(v2, { owners: ['h:ann'] });
  const pin = { version: 2, hash: tip };
  await expect(
    e2ee.verifyHeadChain(back, room, [...chain, await link(sets, 'h:ann', v3)], undefined, pin),
  ).rejects.toThrow();
  const restored = await next(v2, { owners: ['h:ben', 'h:ann'] });
  const v4 = await next(restored, { owners: ['h:ann'] });
  const full = [...chain, await link(sets, 'h:ben', restored), await link(sets, 'h:ann', v4)];
  await expect(e2ee.verifyHeadChain(back, room, full, undefined, pin)).resolves.toBeTruthy();
});

it('accepts only a policy the current chain head signed, never an older one', async () => {
  const head = await e2ee.workspaceIdentity();
  const other = await e2ee.workspaceIdentity();
  const chain = {
    workspace: account,
    root: head.signPub,
    head: { n: 2, link: 'L'.repeat(43), identity: head.signPub },
    identities: new Map(),
  } as unknown as VerifiedChain;
  const on = await e2ee.signChatPolicy(chain, head, { version: 3, adminRead: true });
  expect((await e2ee.verifyChatPolicy(chain, on))?.adminRead).toBe(true);
  // A server-made, re-signed, altered or previous-head policy reads as off.
  const unsigned = { policy: { ...on.policy }, sig: '' };
  const forged = {
    ...on,
    sig: (await e2ee.signChatPolicy(chain, head, { version: 3, adminRead: false })).sig,
  };
  const stale = { ...chain, head: { ...chain.head, n: 3 } };
  expect(await e2ee.verifyChatPolicy(chain, unsigned)).toBeUndefined();
  expect(await e2ee.verifyChatPolicy(chain, forged)).toBeUndefined();
  expect(
    await e2ee.verifyChatPolicy(chain, { ...on, policy: { ...on.policy, version: 4 } }),
  ).toBeUndefined();
  expect(await e2ee.verifyChatPolicy(stale, on)).toBeUndefined();
  expect(await e2ee.verifyChatPolicy(chain, null)).toBeUndefined();
  await expect(
    e2ee.signChatPolicy(chain, other, { version: 4, adminRead: true }),
  ).rejects.toThrow();
  await expect(e2ee.verifyChatPolicy(chain, on, 4)).rejects.toThrow();
});

it('seals to admins under the policy, never to agents outside the team, and shares history', async () => {
  const sets = await people(['h:ann', 'h:ben', 'h:boss', 'a:red', 'a:blue']);
  const nonce = 'm'.repeat(22);
  const id = await e2ee.groupRoomId('h:ann', nonce);
  const members = ['h:ann', 'h:ben', 'a:red', 'a:blue'];
  const head = { room: id, version: 1, prev: '', owners: ['h:ann'], members, team: 'red' };
  const chain = [await link(sets, 'h:ann', head)];
  const tip = await e2ee.headHash(head);
  const room: e2ee.ChatRoom = {
    id,
    kind: 'group',
    nonce,
    head: tip,
    headVersion: 1,
    lastSeq: 0,
    lastAt: 0,
    readSeq: 0,
    unread: 0,
    chain,
    members: members.map((p) => ({
      principal: p,
      type: p[0] === 'h' ? 'human' : 'agent',
      kid: sets[p]!.kid,
      readSeq: 0,
      joinedSeq: p === 'h:ben' ? 5 : 0,
    })),
  };
  const ann: e2ee.ChatKeys = {
    ...keysFor('h:ann', sets),
    teamsOf: (p) => (p === 'a:red' ? ['red'] : p === 'a:blue' ? ['blue'] : undefined),
    observers: () => [{ kid: sets['h:boss']!.kid, box: sets['h:boss']!.boxPub }],
  };
  const envelope = await e2ee.sealChat(ann, room, { id: crypto.randomUUID(), text: 'hi' });
  const kid = (p: string) => sets[p]!.kid;
  expect(envelope.to.map((r) => r.kid).sort()).toEqual(
    ['h:ann', 'h:ben', 'a:red', 'h:boss'].map(kid).sort(),
  );
  // A manager outside the room opens it only as an observer.
  const boss = keysFor('h:boss', sets);
  await expect(e2ee.verifyChatRoom(boss, room)).rejects.toThrow();
  await e2ee.verifyChatRoom(boss, room, { observe: true });
  // Shared history: within the grantee's join, humans-only rows never reach an agent.
  const record = (seq: number, audience: 'all' | 'humans', env: typeof envelope) =>
    ({
      seq,
      id: 'x',
      sender: 'h:ann',
      sub: '',
      at: 0,
      kind: 'message',
      audience,
      envelope: env,
    }) as const;
  const records = [
    record(1, 'all', envelope),
    record(2, 'humans', envelope),
    record(9, 'all', envelope),
  ];
  const ben = room.members.find((m) => m.principal === 'h:ben')!;
  const granted = await e2ee.shareHistory(ann, ben, [...records]);
  expect(Object.keys(granted)).toEqual(['1', '2']);
  expect(granted[1]!.kid).toBe(kid('h:ben'));
  const red = { ...room.members.find((m) => m.principal === 'a:red')!, joinedSeq: 5 };
  expect(Object.keys(await e2ee.shareHistory(ann, red, [...records]))).toEqual(['1']);
});
