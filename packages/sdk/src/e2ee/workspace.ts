import type { Certificate, SealedEnvelope } from '../schema/e2ee';
import type { Keyring } from './keyring';
import { b64u, bytesOf, fail, utf8, type Bytes } from './bytes';
import { canon } from './canon';
import { H, hkdf, hmac } from './hash';
import { open, seal, type Opener, type RecipientKey, type Signer } from './envelope';
import { fingerprint, importPrivate, keySet, kid, sign, verify, type KeySet } from './keys';
import { now } from './random';
// Team workspaces: a succession chain of workspace identities, one signed roster, team keys.

export interface LinkStatement {
  v: 1;
  workspace: string;
  n: number;
  identity: string;
  box: string;
  recovery: string;
  prev?: string;
  created: string;
}
export interface ChainLink {
  statement: LinkStatement;
  sig: string;
  prevSig?: string;
}
export interface RosterMember {
  user: string;
  /** Display name, set by the device that confirmed the member; apps show it, never the server's. */
  name: string;
  identity: string;
  inbox: string;
  /** `connect`: may certify integrations; `keys`: holds the workspace identity. */
  caps: ('connect' | 'keys')[];
  teams: string[];
}
export interface RosterTeam {
  id: string;
  slug: string;
  /** Public box keys by version, newest last; `keys[kv - 1]` is version `kv`. */
  keys: string[];
}
export interface Roster {
  v: 1;
  workspace: string;
  epoch: number;
  n: number;
  head: string;
  members: RosterMember[];
  teams: RosterTeam[];
  created: string;
}
export interface SignedRoster {
  roster: Roster;
  sig: string;
}
/** What `GET /keys` returns under `workspace`. */
export interface WorkspaceDirectory {
  chain: ChainLink[];
  roster: SignedRoster;
}
/**
 * The newest chain head and roster a client has verified; later directories may not go back. Env
 * token clients pass it as `HERALD_PIN` (this object as JSON).
 */
export interface WorkspacePin {
  workspace: string;
  n: number;
  link: string;
  epoch: number;
  roster: string;
}
export interface VerifiedChain {
  workspace: string;
  /** Link 0's identity; team kids and the safety code derive from it. */
  root: string;
  head: {
    n: number;
    link: string;
    identity: string;
    box: string;
    recovery: string;
    signerKid: string;
    boxKid: string;
    recoveryKid: string;
  };
  /** Every link's identity by signer kid. */
  identities: Map<string, string>;
}
export type VerifiedMember = RosterMember & { kid: string; inboxKid: string };
export type VerifiedTeam = RosterTeam & { kv: number; box: string; kid: string; kids: string[] };
export interface VerifiedWorkspace extends VerifiedChain {
  epoch: number;
  digest: string;
  members: Map<string, VerifiedMember>;
  teams: Map<string, VerifiedTeam>;
  pin: WorkspacePin;
}
export interface CheckedCertificate {
  kid: string;
  sign: string;
  box: string;
  /** Effective teams, the connection's default first. */
  teams: string[];
  by?: string;
}
const MAX_LINKS = 256;
const CAPS = ['connect', 'keys'];
const int = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, max = 200) =>
  typeof value === 'string' && value !== '' && value.length <= max;

/** `b64u(H("link", canon(statement)))`: a link's digest, pinned and chained by `prev`. */
export const linkDigest = async (statement: LinkStatement) =>
  b64u.encode(await H('link', canon(statement)));
/** `b64u(H("roster", canon(roster)))`: the digest a client pins with the epoch. */
export const rosterDigest = async (roster: Roster) => b64u.encode(await H('roster', canon(roster)));
/** A member's or workspace identity's signer kid. */
export const signerKid = (identity: string) => kid(bytesOf(identity, 32));

/** A workspace identity: the key set, its signer kid and its box recipient kid. */
export async function workspaceIdentity(seed?: Uint8Array | string) {
  const set = await keySet(seed);
  const id = bytesOf(set.signPub, 32);
  return { ...set, kid: await kid(id), boxKid: await kid(id, bytesOf(set.boxPub, 32)) };
}
export type WorkspaceIdentity = Awaited<ReturnType<typeof workspaceIdentity>>;

/** The recovery key's X25519 opener; only `boxPub` is published. */
export async function recoveryKeySet(recovery: Uint8Array): Promise<Opener & { boxPub: string }> {
  const { priv, pub } = await importPrivate(
    'X25519',
    await hkdf(bytesOf(recovery, 32), 'herald/e2ee/v1 recovery-ws'),
  );
  return { kid: await kid(pub), boxPub: b64u.encode(pub), boxPriv: priv };
}

/** A team key version from its seed; `kid` is `kid(root, box)`. */
export async function teamKeySet(seed: Uint8Array | string, root: string): Promise<KeySet> {
  const set = await keySet(seed);
  return { ...set, kid: await kid(bytesOf(root, 32), bytesOf(set.boxPub, 32)) };
}

/** A new chain link; `prev` is the current head and its identity, which signs the succession. */
export async function workspaceLink(input: {
  workspace: string;
  identity: WorkspaceIdentity;
  recovery: string;
  prev?: { link: ChainLink; identity: WorkspaceIdentity };
}): Promise<ChainLink> {
  const { workspace, identity, prev } = input;
  bytesOf(input.recovery, 32);
  const statement: LinkStatement = {
    v: 1,
    workspace,
    n: prev ? prev.link.statement.n + 1 : 0,
    identity: identity.signPub,
    box: identity.boxPub,
    recovery: input.recovery,
    ...(prev ? { prev: await linkDigest(prev.link.statement) } : {}),
    created: now(),
  };
  const sig = await sign(identity.signPriv, await H('workspace', canon(statement)));
  if (!prev) return { statement, sig };
  if (prev.identity.signPub !== prev.link.statement.identity) fail('Wrong previous identity.');
  return {
    statement,
    sig,
    prevSig: await sign(prev.identity.signPriv, await H('succession', canon(statement))),
  };
}

function checkPin(pin: WorkspacePin | undefined, workspace: string) {
  if (pin && parseWorkspacePin(pin).workspace !== workspace) fail('Workspace pin mismatch.');
  return pin;
}
const digestText = (value: unknown) => typeof value === 'string' && /^[\w-]{43}$/.test(value);

/** A pin from its JSON text (`HERALD_PIN`, a pin file) or object; malformed pins fail. */
export function parseWorkspacePin(value: unknown): WorkspacePin {
  let p = value;
  if (typeof p === 'string')
    try {
      p = JSON.parse(p);
    } catch {
      p = undefined;
    }
  const pin = p as WorkspacePin;
  const ok =
    text(pin?.workspace) &&
    pin.workspace.startsWith('ws_') &&
    int(pin.n) &&
    int(pin.epoch) &&
    pin.epoch >= 1 &&
    digestText(pin.link) &&
    digestText(pin.roster);
  if (!ok) fail('Malformed workspace pin.');
  const { workspace, n, link, epoch, roster } = pin;
  return { workspace, n, link, epoch, roster };
}

/** Fails unless `next` is the same as or newer than `pin` (no rollback, fork or stale roster). */
export function checkNewerPin(pin: WorkspacePin, next: WorkspacePin) {
  if (pin.workspace !== next.workspace) fail('Workspace pin mismatch.');
  if (next.n < pin.n) fail('Workspace chain rollback.');
  if (next.n === pin.n && next.link !== pin.link) fail('Workspace chain fork.');
  if (next.epoch < pin.epoch || (next.epoch === pin.epoch && next.roster !== pin.roster))
    fail('Stale roster epoch.');
}

/** A personal keyring's anchor for one workspace: its root fingerprint and newest pin. */
export interface KeyringWorkspace {
  workspace: string;
  fingerprint: string;
  pin?: WorkspacePin;
}
/**
 * Records a workspace anchor in the personal keyring (which syncs to all the member's devices).
 * A stored root is never replaced (mismatch fails) and a stored pin never goes back; store only
 * pins `verifyWorkspace` returned under the stored pin.
 */
export function keyringPin(keyring: Keyring, entry: KeyringWorkspace): Keyring {
  const { workspace, fingerprint: fp } = entry;
  if (!text(workspace) || !workspace.startsWith('ws_') || !/^[\w-]{22}$/.test(fp))
    fail('Malformed workspace anchor.');
  const pin = entry.pin && parseWorkspacePin(entry.pin);
  if (pin && pin.workspace !== workspace) fail('Workspace pin mismatch.');
  const list = keyring.workspaces ?? [];
  const old = list.find((w) => w.workspace === workspace);
  if (old && old.fingerprint !== fp) fail('Workspace fingerprint mismatch.');
  if (old?.pin && pin) checkNewerPin(old.pin, pin);
  const next = { workspace, fingerprint: fp, ...((pin ?? old?.pin) && { pin: pin ?? old!.pin }) };
  return { ...keyring, workspaces: [...list.filter((w) => w !== old), next] };
}

/** Verifies the chain from the pinned root fingerprint to its head, against a pinned head. */
export async function verifyChain(
  chain: ChainLink[],
  pinnedFp: string,
  options: { workspace?: string; pin?: WorkspacePin } = {},
): Promise<VerifiedChain> {
  if (!Array.isArray(chain) || !chain.length || chain.length > MAX_LINKS)
    fail('Malformed workspace chain.');
  const workspace = chain[0]?.statement?.workspace;
  if (!text(workspace) || !workspace.startsWith('ws_')) fail('Malformed workspace chain.');
  if (options.workspace !== undefined && workspace !== options.workspace)
    fail('Workspace mismatch.');
  const pin = checkPin(options.pin, workspace);
  if ((await fingerprint(chain[0].statement.identity)) !== pinnedFp)
    fail('Workspace fingerprint mismatch.');
  const identities = new Map<string, string>();
  let prev: LinkStatement | undefined;
  let digest = '';
  for (const [i, link] of chain.entries()) {
    const s = link?.statement;
    if (s?.v !== 1 || s.n !== i || s.workspace !== workspace || !text(s.created, 40))
      fail('Malformed workspace chain.');
    for (const key of [s.identity, s.box, s.recovery]) bytesOf(key, 32);
    if (!(await verify(s.identity, link.sig, await H('workspace', canon(s)))))
      fail('Bad workspace link signature.');
    if (prev) {
      if (s.prev !== digest) fail('Workspace chain is broken.');
      if (!(await verify(prev.identity, link.prevSig ?? '', await H('succession', canon(s)))))
        fail('Bad workspace succession signature.');
    } else if (s.prev !== undefined || link.prevSig !== undefined)
      fail('Malformed workspace chain.');
    digest = await linkDigest(s);
    if (pin && i === pin.n && digest !== pin.link) fail('Workspace chain fork.');
    identities.set(await signerKid(s.identity), s.identity);
    prev = s;
  }
  if (pin && chain.length <= pin.n) fail('Workspace chain rollback.');
  const head = prev!;
  const id = bytesOf(head.identity, 32);
  return {
    workspace,
    root: chain[0].statement.identity,
    head: {
      n: head.n,
      link: digest,
      identity: head.identity,
      box: head.box,
      recovery: head.recovery,
      signerKid: await kid(id),
      boxKid: await kid(id, bytesOf(head.box, 32)),
      recoveryKid: await kid(bytesOf(head.recovery, 32)),
    },
    identities,
  };
}

/** Signs a roster as the chain head; `head` is the current head link. */
export async function signRoster(
  input: Pick<Roster, 'epoch' | 'members' | 'teams'> & { head: ChainLink },
  identity: WorkspaceIdentity,
): Promise<SignedRoster> {
  const { head } = input;
  if (identity.signPub !== head.statement.identity) fail('Rosters are signed by the chain head.');
  const roster: Roster = {
    v: 1,
    workspace: head.statement.workspace,
    epoch: input.epoch,
    n: head.statement.n,
    head: await linkDigest(head.statement),
    members: input.members,
    teams: input.teams,
    created: now(),
  };
  return { roster, sig: await sign(identity.signPriv, await H('roster', canon(roster))) };
}

/**
 * Verifies a roster against a verified chain: signed by the head, not older than the pin or than
 * `minEpoch` (the caller's own certificate epoch), and well formed.
 */
export async function verifyRoster(
  signed: SignedRoster,
  chain: VerifiedChain,
  options: { pin?: WorkspacePin; minEpoch?: number } = {},
): Promise<VerifiedWorkspace> {
  const r = signed?.roster;
  if (r?.v !== 1 || r.workspace !== chain.workspace || !int(r.epoch) || r.epoch < 1)
    fail('Malformed roster.');
  if (r.n !== chain.head.n || r.head !== chain.head.link) fail('Roster is not signed by the head.');
  if (!(await verify(chain.head.identity, signed.sig, await H('roster', canon(r)))))
    fail('Bad roster signature.');
  const digest = await rosterDigest(r);
  const pin = checkPin(options.pin, chain.workspace);
  if (pin && (r.epoch < pin.epoch || (r.epoch === pin.epoch && digest !== pin.roster)))
    fail('Stale roster epoch.');
  if (options.minEpoch !== undefined && r.epoch < options.minEpoch) fail('Stale roster epoch.');
  if (!Array.isArray(r.members) || !Array.isArray(r.teams)) fail('Malformed roster.');
  if (r.members.length > 500 || r.teams.length > 100) fail('Roster is too large.');
  const teams = new Map<string, VerifiedTeam>();
  const slugs = new Set<string>();
  const root = bytesOf(chain.root, 32);
  for (const t of r.teams) {
    if (!text(t?.id) || !text(t.slug, 64) || teams.has(t.id) || slugs.has(t.slug))
      fail('Malformed roster team.');
    if (!Array.isArray(t.keys) || !t.keys.length || t.keys.length > 1000)
      fail('Malformed roster team.');
    const kids: string[] = [];
    for (const box of t.keys) kids.push(await kid(root, bytesOf(box, 32)));
    slugs.add(t.slug);
    teams.set(t.id, { ...t, kv: t.keys.length, box: t.keys.at(-1)!, kid: kids.at(-1)!, kids });
  }
  const members = new Map<string, VerifiedMember>();
  for (const m of r.members) {
    const caps = m?.caps;
    const ok =
      text(m?.user) &&
      !members.has(m.user) &&
      text(m.name, 400) &&
      [...m.name].length <= 100 &&
      Array.isArray(caps) &&
      caps.every((c) => CAPS.includes(c)) &&
      new Set(caps).size === caps.length &&
      Array.isArray(m.teams) &&
      new Set(m.teams).size === m.teams.length &&
      m.teams.every((id) => teams.has(id));
    if (!ok) fail('Malformed roster member.');
    const id = bytesOf(m.identity, 32);
    members.set(m.user, {
      ...m,
      kid: await kid(id),
      inboxKid: await kid(id, bytesOf(m.inbox, 32)),
    });
  }
  return {
    ...chain,
    epoch: r.epoch,
    digest,
    members,
    teams,
    pin: {
      workspace: chain.workspace,
      n: chain.head.n,
      link: chain.head.link,
      epoch: r.epoch,
      roster: digest,
    },
  };
}

/** Verifies `GET /keys`' `workspace` part under the token's pinned root fingerprint. */
export async function verifyWorkspace(
  directory: WorkspaceDirectory,
  pinnedFp: string,
  options: { workspace?: string; pin?: WorkspacePin; minEpoch?: number } = {},
): Promise<VerifiedWorkspace> {
  if (!directory || typeof directory !== 'object') fail('Malformed workspace directory.');
  const chain = await verifyChain(directory.chain, pinnedFp, options);
  return verifyRoster(directory.roster, chain, options);
}

/**
 * Certifies an integration key set in a workspace. The signer is the head identity, or, with
 * `by`, that member's personal identity key set.
 */
export async function certifyWorkspace(
  input: {
    workspace: string;
    keys: { sign: string; box: string };
    teams: string[];
    epoch: number;
    by?: string;
  },
  signer: { signPriv: CryptoKey },
): Promise<Certificate> {
  const { keys } = input;
  const certificate = {
    v: 1 as const,
    account: input.workspace,
    kid: await kid(bytesOf(keys.sign, 32), bytesOf(keys.box, 32)),
    sign: keys.sign,
    box: keys.box,
    created: now(),
    teams: input.teams,
    epoch: input.epoch,
    ...(input.by === undefined ? {} : { by: input.by }),
  };
  return { certificate, sig: await sign(signer.signPriv, await H('cert', canon(certificate))) };
}

/**
 * Checks a workspace certificate: signed by the head identity, or by a roster member with
 * `connect` (`by`). Integrations and removed members cannot certify, so chains stay two deep.
 */
export async function verifyWorkspaceCertificate(
  cert: Certificate,
  ws: VerifiedWorkspace,
): Promise<CheckedCertificate> {
  const body = cert?.certificate;
  if (body?.v !== 1) fail('Unsupported certificate version.');
  if (body.account !== ws.workspace) fail('Certificate account mismatch.');
  if (body.kid !== (await kid(bytesOf(body.sign, 32), bytesOf(body.box, 32))))
    fail('Certificate kid mismatch.');
  if (!int(body.epoch) || !Array.isArray(body.teams) || !body.teams.length)
    fail('Not a workspace certificate.');
  if (body.epoch! > ws.epoch) fail('Stale roster epoch.');
  let signer = ws.head.identity;
  let allowed = (team: string) => ws.teams.has(team);
  if (body.by !== undefined) {
    const member = ws.members.get(body.by) ?? fail('Unknown certifier.');
    if (!member.caps.includes('connect')) fail('The certifier may not connect integrations.');
    signer = member.identity;
    allowed = (team) => member.teams.includes(team);
  }
  if (!(await verify(signer, cert.sig, await H('cert', canon(body)))))
    fail('Bad certificate signature.');
  const teams = [...new Set(body.teams!)].filter(allowed);
  if (!teams.length) fail('The certificate covers no team.');
  return {
    kid: body.kid,
    sign: body.sign,
    box: body.box,
    teams,
    ...(body.by === undefined ? {} : { by: body.by }),
  };
}

/**
 * Re-certifies under the current head a certificate verified under the previous roster (an
 * explicit, confirmed action, never automatic). Its teams are its effective teams there, so already
 * intersected with its certifier's teams, that still exist; none left fails.
 */
export async function recertifyWorkspace(
  cert: Certificate,
  input: { previous: VerifiedWorkspace; current: VerifiedWorkspace; identity: WorkspaceIdentity },
): Promise<Certificate> {
  const { previous, current, identity } = input;
  if (previous.workspace !== current.workspace || previous.epoch >= current.epoch)
    fail('Not the previous roster.');
  if (identity.signPub !== current.head.identity) fail('Certificates are re-signed by the head.');
  const checked = await verifyWorkspaceCertificate(cert, previous);
  const teams = checked.teams.filter((team) => current.teams.has(team));
  if (!teams.length) fail('The certificate covers no team.');
  const keys = { sign: checked.sign, box: checked.box };
  return certifyWorkspace(
    { workspace: current.workspace, keys, teams, epoch: current.epoch },
    identity,
  );
}

/** A member of `team` by user id, or a failure naming why not. */
export function teamMember(ws: VerifiedWorkspace, user: unknown, team: unknown): VerifiedMember {
  const member = (typeof user === 'string' && ws.members.get(user)) || fail('Not a member.');
  if (typeof team !== 'string' || !member.teams.includes(team)) fail('Not a member of the team.');
  return member;
}

/** Key wraps are signed by the current head only; a rotation re-wraps under the new head. */
const headSigner = (ws: VerifiedWorkspace, from: string) =>
  from === ws.head.signerKid ? ws.head.identity : undefined;

const keyRecipients = (ws: VerifiedWorkspace, member: VerifiedMember): RecipientKey[] => [
  { kid: member.inboxKid, box: member.inbox },
  { kid: ws.head.boxKid, box: ws.head.box },
  { kid: ws.head.recoveryKid, box: ws.head.recovery },
];

/** Wraps a team key version to a member's inbox, the head box and the recovery key. */
export async function wrapTeamKey(input: {
  ws: VerifiedWorkspace;
  team: string;
  kv: number;
  member: string;
  seed: string;
  signer: Signer;
}): Promise<SealedEnvelope> {
  const { ws, team, kv, member, seed } = input;
  const target = teamMember(ws, member, team);
  const set = await teamKeySet(seed, ws.root);
  if (ws.teams.get(team)?.keys[kv - 1] !== set.boxPub) fail('Unknown team key version.');
  return seal({
    payload: { seed },
    ctx: { t: 'teamkey', account: ws.workspace, team, kv, member },
    signer: input.signer,
    to: keyRecipients(ws, target),
  });
}

/** Opens a team key wrap; the seed must derive the roster's published key for that version. */
export async function openTeamKey(
  env: SealedEnvelope,
  options: {
    ws: VerifiedWorkspace;
    recipients: Opener[];
    team: string;
    kv: number;
    member: string;
  },
): Promise<KeySet> {
  const { ws, team, kv, member } = options;
  const { seed } = await open<{ seed: string }>(env, {
    recipients: options.recipients,
    signers: (from) => headSigner(ws, from),
    expect: { t: 'teamkey', account: ws.workspace, team, kv, member },
  });
  const set = await teamKeySet(seed, ws.root);
  if (ws.teams.get(team)?.keys[kv - 1] !== set.boxPub) fail('Team key does not match the roster.');
  return set;
}

/** Wraps the identity seed of link `n` to a key holder's inbox and the recovery key. */
export async function wrapWorkspaceKey(input: {
  ws: VerifiedWorkspace;
  n: number;
  member: string;
  seed: string;
  signer: Signer;
}): Promise<SealedEnvelope> {
  const { ws, n, member } = input;
  const holder = ws.members.get(member) ?? fail('Not a member.');
  if (!holder.caps.includes('keys')) fail('The member does not hold the workspace key.');
  return seal({
    payload: { seed: input.seed },
    ctx: { t: 'wskey', account: ws.workspace, n, member },
    signer: input.signer,
    to: [keyRecipients(ws, holder)[0], keyRecipients(ws, holder)[2]],
  });
}

/** Opens an identity wrap; the seed must derive the head's identity at link `n`. */
export async function openWorkspaceKey(
  env: SealedEnvelope,
  options: { ws: VerifiedWorkspace; recipients: Opener[]; n: number; member: string },
): Promise<WorkspaceIdentity> {
  const { ws, n, member } = options;
  const { seed } = await open<{ seed: string }>(env, {
    recipients: options.recipients,
    signers: (from) => headSigner(ws, from),
    expect: { t: 'wskey', account: ws.workspace, n, member },
  });
  const identity = await workspaceIdentity(seed);
  if (n !== ws.head.n || identity.signPub !== ws.head.identity)
    fail('Workspace key does not match the chain.');
  return identity;
}

/** A link invite's secret, recomputable by any device holding the head identity seed. */
export async function inviteSecret(identitySeed: string, invite: string): Promise<Bytes> {
  const key = await hkdf(bytesOf(identitySeed, 32), 'herald/e2ee/v1 invite');
  return hmac(key, utf8(invite));
}
export interface JoinClaim {
  workspace: string;
  /** `fingerprint(root)` the joiner pinned from the invite fragment. */
  fingerprint: string;
  invite: string;
  user: string;
  identity: string;
  inbox: string;
}
/** The joiner's proof that it holds the invite link's secret for exactly these keys. */
export async function joinProof(secret: Uint8Array, claim: JoinClaim): Promise<string> {
  const { workspace, fingerprint, invite, user, identity, inbox } = claim;
  const input = await H('join', canon({ workspace, fingerprint, invite, user, identity, inbox }));
  return b64u.encode(await hmac(bytesOf(secret, 32), input));
}
export async function verifyJoinProof(secret: Uint8Array, claim: JoinClaim, proof: string) {
  const want = bytesOf(await joinProof(secret, claim));
  const got = typeof proof === 'string' ? b64u.decode(proof) : new Uint8Array(0);
  let diff = want.length ^ got.length;
  for (let i = 0; i < want.length; i++) diff |= want[i] ^ (got[i] ?? 0);
  if (diff) fail('Bad join proof.');
}

/** The invite link fragment `<b64u secret>.<fingerprint(root)>`, without `#`. */
export function inviteFragment(secret: Uint8Array, fingerprint: string): string {
  if (!/^[\w-]{22}$/.test(fingerprint)) fail('Malformed fingerprint.');
  return `${b64u.encode(bytesOf(secret, 32))}.${fingerprint}`;
}
/** Reads an invite link fragment (with or without `#`): the secret and the root to pin. */
export function parseInviteFragment(fragment: string): { secret: Bytes; fingerprint: string } {
  const match = /^#?([\w-]{43})\.([\w-]{22})$/.exec(typeof fragment === 'string' ? fragment : '');
  if (!match) return fail('Malformed invite link.');
  return { secret: bytesOf(match[1], 32), fingerprint: match[2] };
}

const MEMBER_SIGNED = ['response', 'task', 'secret'];
/**
 * The signing key a workspace context allows for kid `from`: a member of `ctx.team` for answers,
 * tasks and secrets; an integration certified for `ctx.team` (from `certificates`, by kid) for
 * messages, logs and results; only the current head for key wraps.
 */
export function workspaceSigner(
  ws: VerifiedWorkspace,
  certificates: Map<string, CheckedCertificate>,
  ctx: SealedEnvelope['ctx'],
  from: string,
): string | undefined {
  if (ctx?.account !== ws.workspace) return undefined;
  if (ctx.t === 'teamkey' || ctx.t === 'wskey') return headSigner(ws, from);
  if (MEMBER_SIGNED.includes(ctx.t)) {
    const member = teamMember(ws, ctx.member, ctx.team);
    return from === member.kid ? member.identity : undefined;
  }
  const cert = certificates.get(from);
  return cert && cert.teams.includes(ctx.team as string) ? cert.sign : undefined;
}
