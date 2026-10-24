import { z } from 'zod';
import * as e2ee from './e2ee/index.js';
import {
  E2eeError,
  type CheckedCertificate,
  type KeySet,
  type RecipientKey,
  type SealedEnvelope,
  type VerifiedWorkspace,
  type WorkspacePin,
} from './e2ee/index.js';
import {
  answersSchema,
  matchesAction,
  messageInputSchema,
  sealedMessageInputSchema,
  sessionInputSchema,
  sessionValues,
  unitEnvelopeChars,
  unitKeySchema,
  unitStateSchema,
  validateAnswers,
  type Attachment,
  type KeyDirectory,
  type Message,
  type MessageRequest,
  type SealedMessageInput,
  type TaskLog,
  type UnitActivity,
  type UnitState,
} from './schema/index.js';
import { HeraldError } from './http.js';
/** A unit's state as reporters pass it; invalid `kind` and `activity` read as `agent`, `idle`. */
export type UnitStateInput = Omit<z.input<typeof unitStateSchema>, 'kind' | 'activity'> & {
  kind?: string;
  activity?: UnitActivity;
};
/** An attachment with its file key; keyed uploads return one and keyed messages carry them. */
export type FileAttachment = Attachment & { key?: string };
/** A task log line; sealed lines are opened, or flagged when they cannot be. */
export type OpenedLog = TaskLog & { e2ee?: boolean; locked?: boolean; unverified?: boolean };
type State = {
  directory: KeyDirectory;
  account: string;
  me: KeySet;
  identity: string;
  identityKid: string;
  inbox: RecipientKey;
  /** Certified integration kids → signing keys, and integration IDs → kids. */
  signers: Map<string, string>;
  kids: Map<string, string>;
  /** Team workspaces: the verified chain and roster, certificates by kid, and this token's. */
  ws?: VerifiedWorkspace;
  certs: Map<string, CheckedCertificate>;
  mine?: CheckedCertificate;
};
/** A team workspace as this token sees it. */
export type WorkspaceInfo = {
  id: string;
  /** The workspace safety code's fingerprint (its root identity). */
  fingerprint: string;
  epoch: number;
  /** Teams this connection may address, its default first. */
  teams: { id: string; slug: string }[];
  /** Every team in the workspace. */
  allTeams: { id: string; slug: string }[];
};
export type KeyedOptions = {
  /** The newest workspace chain head and roster this token verified; older ones are refused. */
  pin?: WorkspacePin;
  /** Called when a newer pin was verified, to store it with the token. */
  onPin?: (pin: WorkspacePin) => void;
};
type Payload = Record<string, unknown>;
/** Picks the one kid allowed to sign an envelope, from the verified directory. */
type SignerOf = (s: State, env?: SealedEnvelope) => string | undefined;
const NO_ENTRY = 'No recipient entry for these keys.';
const CONTENT = [
  'title',
  'body',
  'kind',
  'fields',
  'blocks',
  'actions',
  'requiresReview',
  'runId',
  'checkpointId',
  'group',
] as const;
const ENVELOPE_LIMIT = 20_000;
const fileEntry = z.object({
  id: z.string().uuid(),
  name: z.string().max(200),
  type: z.string().max(120),
  size: z.number().int().nonnegative(),
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const fileList = z.array(fileEntry).max(30).optional();
const fail = (message: string): never => {
  throw new E2eeError(message);
};
/** A shallow copy without `keys` and without undefined values. */
function omit<T extends object>(value: T, ...keys: string[]): T {
  const entries = Object.entries(value).filter(([k, v]) => v !== undefined && !keys.includes(k));
  return Object.fromEntries(entries) as T;
}
/** Placeholder content for a record that could not be opened or verified. */
function strip<M extends Message>(m: M, flag: 'locked' | 'unverified'): M {
  const out: Message = { ...omit(m, 'blocks', 'actions', 'session'), e2ee: true, [flag]: true };
  const title = m.kind === 'secret' ? 'Encrypted secret' : 'Encrypted message';
  if (m.direction !== 'outbound') Object.assign(out, { title, body: '', fields: [] });
  if (m.response) out.response = { ...omit(m.response, 'actionId'), values: {} };
  if (m.input) out.input = { ...omit(m.input, 'session'), values: {} };
  if (m.result) out.result = omit(m.result, 'error');
  if (m.execution) out.execution = omit(m.execution, 'error');
  return out as M;
}
/** End-to-end encryption for one keyed token: seals what it sends, opens what it reads. */
export class KeyedSession {
  readonly seed: string;
  readonly fingerprint: string;
  /** File keys learned from uploads and opened records, by file ID. */
  readonly files = new Map<string, FileAttachment>();
  #directory: () => Promise<KeyDirectory>;
  #state?: Promise<State>;
  #loaded = 0;
  #options: KeyedOptions;
  /** Record IDs → their team: set at send time or from a verified envelope's `ctx.team` only. */
  #teams = new Map<string, string>();
  constructor(
    seed: string,
    fingerprint: string,
    directory: () => Promise<KeyDirectory>,
    options: KeyedOptions = {},
  ) {
    this.seed = seed;
    this.fingerprint = fingerprint;
    this.#directory = directory;
    this.#options = { ...options };
  }
  /** The workspace pin this session holds, if its token belongs to a team workspace. */
  get pin(): WorkspacePin | undefined {
    return this.#options.pin;
  }
  /**
   * The verified key directory, fetched once; `refresh` refetches at most every 10 s, `force`
   * at once (after `409 E2EE_STALE_KEY`).
   */
  state(refresh: boolean | 'force' = false): Promise<State> {
    const due = refresh === 'force' || (refresh && Date.now() - this.#loaded > 10_000);
    if (!this.#state || due) {
      this.#loaded = Date.now();
      const next = this.#load();
      this.#state = next;
      next.catch(() => {
        if (this.#state === next) this.#state = undefined;
      });
    }
    return this.#state;
  }
  async #load(): Promise<State> {
    const [directory, me] = await Promise.all([this.#directory(), e2ee.keySet(this.seed)]);
    if (directory.workspace) return this.#loadWorkspace(directory, me);
    if (this.#options.pin)
      fail('This token belongs to a team workspace, but the server sent none.');
    if (!directory.account)
      fail(
        'End-to-end encryption is not set up for this account yet. Open Herald on a signed-in device first.',
      );
    const info = await e2ee.verifyAccount(directory.account!, this.fingerprint);
    const account = directory.account!.statement.account;
    const signers = new Map<string, string>(),
      kids = new Map<string, string>();
    for (const cert of directory.certificates) {
      const checked = await e2ee.verifyCertificate(cert, info.identity, account).catch(() => {});
      if (!checked) continue;
      signers.set(checked.kid, checked.sign);
      kids.set(cert.integrationId, checked.kid);
    }
    if (signers.get(me.kid) !== me.signPub)
      fail("This token's key is not certified for the account.");
    return {
      directory,
      account,
      me,
      identity: info.identity,
      identityKid: info.signerKid,
      inbox: { kid: info.inboxKid, box: info.inbox },
      signers,
      kids,
      certs: new Map(),
    };
  }
  /** A team workspace: chain and roster under the pinned root, member-certified integrations. */
  async #loadWorkspace(directory: KeyDirectory, me: KeySet): Promise<State> {
    const ws = await e2ee.verifyWorkspace(directory.workspace!, this.fingerprint, {
      pin: this.#options.pin,
    });
    const signers = new Map<string, string>(),
      kids = new Map<string, string>(),
      certs = new Map<string, CheckedCertificate>();
    for (const cert of directory.certificates) {
      const checked = await e2ee.verifyWorkspaceCertificate(cert, ws).catch(() => {});
      if (!checked) continue;
      signers.set(checked.kid, checked.sign);
      kids.set(cert.integrationId, checked.kid);
      certs.set(checked.kid, checked);
    }
    // A certificate newer than the roster fails above, so a server cannot roll this token back.
    const mine = certs.get(me.kid);
    if (mine?.sign !== me.signPub) fail("This token's key is not certified for the workspace.");
    const pin = this.#options.pin;
    if (!pin || pin.epoch !== ws.pin.epoch || pin.n !== ws.pin.n) {
      this.#options.pin = ws.pin;
      this.#options.onPin?.(ws.pin);
    }
    return {
      directory,
      account: ws.workspace,
      me,
      identity: ws.head.identity,
      identityKid: ws.head.signerKid,
      inbox: { kid: ws.head.boxKid, box: ws.head.box },
      signers,
      kids,
      ws,
      certs,
      mine,
    };
  }
  /** The team workspace this token belongs to, or undefined for a personal account. */
  async workspace(): Promise<WorkspaceInfo | undefined> {
    const { ws, mine } = await this.state();
    if (!ws || !mine) return undefined;
    const team = (id: string) => ({ id, slug: ws.teams.get(id)!.slug });
    return {
      id: ws.workspace,
      fingerprint: this.fingerprint,
      epoch: ws.epoch,
      teams: mine.teams.map(team),
      allTeams: [...ws.teams.keys()].map(team),
    };
  }
  /** A team id from an id or slug, among this connection's teams; its default when omitted. */
  #team(s: State, wanted?: string): string | undefined {
    if (!s.ws) return wanted === undefined ? undefined : fail('Teams need a team workspace token.');
    if (wanted === undefined) return s.mine!.teams[0];
    const id = s.ws.teams.has(wanted)
      ? wanted
      : [...s.ws.teams.values()].find((t) => t.slug === wanted)?.id;
    if (!id) return fail(`Unknown team ${wanted}.`);
    if (!s.mine!.teams.includes(id)) return fail(`This connection may not address team ${wanted}.`);
    return id;
  }
  /** Team records seal to the team's current key; personal ones to the account inbox. */
  #to = (s: State, team?: string): RecipientKey[] => {
    const me = { kid: s.me.kid, box: s.me.boxPub };
    if (!s.ws) return [s.inbox, me];
    const t = (team && s.ws.teams.get(team)) || fail('Unknown team.');
    if (!s.mine!.teams.includes(team!)) fail('This connection may not address the team.');
    return [{ kid: t.kid, box: t.box }, me];
  };
  /** A record's team; `record` loads it when this session has not opened it yet. */
  async teamOf(id: string, record?: () => Promise<Message>): Promise<string | undefined> {
    const s = await this.state();
    if (!s.ws) return undefined;
    if (!this.#teams.has(id) && record) await this.openRecord(await record());
    return this.#teams.get(id) ?? fail('The record has no team.');
  }
  /** Opens `env` if exactly the kid `signer` picks signed it; a new certificate triggers a refetch. */
  async #open<T extends Payload>(
    env: SealedEnvelope,
    expect: Record<string, string | number | undefined> & { t: string },
    signer: SignerOf,
  ): Promise<T> {
    let s = await this.state();
    if (signer(s, env) !== env.from) s = await this.state(true);
    const kid = signer(s, env);
    const ws = s.ws;
    if (ws && typeof expect.team !== 'string') fail('The record has no team.');
    const key = ws
      ? kid === env.from && kid
        ? e2ee.workspaceSigner(ws, s.certs, env.ctx, kid)
        : undefined
      : kid === s.identityKid
        ? s.identity
        : kid && s.signers.get(kid);
    if (!ws) delete expect.team;
    return e2ee.open<T>(env, {
      recipients: [s.me],
      signers: (from) => (from === kid && key) || undefined,
      expect: { ...expect, account: s.account },
    });
  }
  /** The account identity, or in a team workspace the member named by `ctx.member`. */
  static #identity: SignerOf = (s, env) =>
    s.ws ? s.ws.members.get(String(env?.ctx.member))?.kid : s.identityKid;
  static #integration =
    (id?: string): SignerOf =>
    (s) =>
      id ? s.kids.get(id) : undefined;
  #learn(files: FileAttachment[] = []) {
    for (const file of files) if (file.key) this.files.set(file.id, file);
  }
  /**
   * Seals a message request under a new record ID. Secret offers seal their title and body; the
   * value itself goes to the receiver the account signs.
   */
  async sealMessage(input: MessageRequest, idempotencyKey: string): Promise<SealedMessageInput> {
    const parsed = messageInputSchema.safeParse(input);
    if (!parsed.success) throw new HeraldError(z.prettifyError(parsed.error), 400);
    const s = await this.state();
    const id = crypto.randomUUID();
    const team = this.#team(s, parsed.data.team);
    if (team) this.#teams.set(id, team);
    const seal = async (payload: Payload) => ({
      id,
      ...(team ? { team } : {}),
      sealed: await e2ee.seal({
        payload,
        ctx: { t: 'message', account: s.account, id, ...(team ? { team } : {}) },
        signer: s.me,
        to: this.#to(s, team),
      }),
      digest: await e2ee.idempotencyDigest(this.seed, payload, idempotencyKey),
      taskId: parsed.data.taskId,
      replyTo: parsed.data.replyTo,
      expiresAt: parsed.data.expiresAt,
      expiresIn: parsed.data.expiresIn,
    });
    if (parsed.data.kind === 'secret') {
      const { title, body } = parsed.data;
      return sealedMessageInputSchema.parse({
        ...(await seal({ kind: 'secret', title, body })),
        kind: 'secret',
        asks: false,
      });
    }
    const data = parsed.data;
    const attachments = ((input.attachments || []) as FileAttachment[]).map((file) => {
      const known = { ...this.files.get(file.id), ...file };
      if (!known.key) fail(`Attachment ${file.id} was not uploaded by this keyed client.`);
      return fileEntry.parse({
        id: known.id,
        name: known.name,
        type: known.type,
        size: known.size,
        key: known.key,
      });
    });
    const payload: Payload = { attachments };
    for (const key of CONTENT) if (data[key] !== undefined) payload[key] = data[key];
    return sealedMessageInputSchema.parse({
      ...(await seal(payload)),
      asks: data.kind === 'form' || !!data.fields.length || !!data.actions?.length,
      attachments: attachments.map((file) => ({ id: file.id })),
    });
  }
  /**
   * Opens a record's sealed parts into a plain record with `e2ee: true`; failures are flagged.
   * Content comes only from verified envelopes: an unsealed record and a sealed request with an
   * unsealed answer are `unverified`.
   */
  async openRecord<M extends Message>(m: M, options: { task?: boolean } = {}): Promise<M> {
    if (!m || typeof m !== 'object') return m;
    const { ws, mine } = await this.state();
    const task = options.task || m.direction === 'outbound';
    // `answeredBy` comes only from a verified answer.
    m = { ...m, ...(m.response ? { response: omit(m.response, 'by') } : {}) };
    delete m.answeredBy;
    try {
      if (task) {
        if (!m.input?.sealed) fail('This task is not end-to-end encrypted.');
        if (m.recipientId) this.#runners.set(m.id, m.recipientId);
      } else if (!m.sealed) fail('This message is not end-to-end encrypted.');
      // The server's `team` counts only once the envelope's signed `ctx.team` matched it.
      if (ws && !mine!.teams.includes(m.team as string))
        fail('The record is outside the teams this connection is certified for.');
      let out: M = { ...m, e2ee: true };
      if (task) out = await this.#task(out, m.input!.sealed!);
      else out = await this.#content(out, m.sealed!);
      if (ws) this.#teams.set(m.id, m.team!);
      if (!task && m.response?.sealed)
        out = await this.#response(out, m.sealed!, m.response.sealed);
      else if (!task && out.kind !== 'secret' && (m.response || m.status === 'answered'))
        fail('A sealed request needs a sealed answer.');
      for (const key of ['result', 'execution'] as const) {
        if (!m[key]) continue;
        const env = m[key].sealed;
        let error: unknown;
        if (env) {
          const runner = KeyedSession.#integration(m.recipientId);
          const expect = { t: 'result', task: m.id, team: m.team };
          ({ error } = await this.#open(env, expect, runner));
          if (error !== undefined && error !== null && typeof error !== 'string')
            fail('Malformed task result.');
        }
        out = { ...out, [key]: omit({ ...omit(m[key], 'error'), error: error ?? undefined }) };
      }
      return out;
    } catch (error) {
      if (!(error instanceof E2eeError)) throw error;
      return strip(m, error.message === NO_ENTRY ? 'locked' : 'unverified');
    }
  }
  /** Task IDs → the integration that runs them, so logs open only under its key. */
  #runners = new Map<string, string>();
  async #content<M extends Message>(out: M, env: SealedEnvelope): Promise<M> {
    const sender = KeyedSession.#integration(out.senderId);
    const opened = await this.#open(env, { t: 'message', id: out.id, team: out.team }, sender);
    const { attachments, ...rest } = opened;
    const files = fileList.safeParse(attachments);
    const parsed = messageInputSchema.safeParse({ ...rest, attachments: files.data });
    if (!files.success || !parsed.success) return fail('Malformed message content.');
    if ((parsed.data.kind === 'secret') !== (out.kind === 'secret'))
      fail('The message kind does not match its record.');
    this.#learn(files.data);
    const content: Payload = {};
    for (const key of CONTENT) content[key] = (parsed.data as Payload)[key];
    // Server copies of content fields are dropped; only the envelope's count.
    return { ...omit(out, ...CONTENT), ...omit(content), attachments: files.data || [] } as M;
  }
  async #task<M extends Message>(out: M, env: SealedEnvelope): Promise<M> {
    const expect = {
      t: 'task',
      id: out.id,
      destination: out.destinationId!,
      type: out.typeId!,
      team: out.team,
    };
    const opened = await this.#open(env, expect, KeyedSession.#identity);
    const { values = {}, session, attachments } = opened;
    const answers = answersSchema.safeParse(values);
    const typed = session === undefined ? undefined : sessionInputSchema.safeParse(session);
    const files = fileList.safeParse(attachments);
    if (!answers.success || !files.success || (typed && !typed.success))
      fail('Malformed task input.');
    this.#learn(files.data);
    const run = typed?.data;
    // Like plaintext tasks: flat values for runners reading `response.values`, plus `session`.
    const flat = run ? { ...answers.data!, ...sessionValues(run) } : answers.data!;
    // Server copies of the input, session and answer are dropped; only the envelope's count.
    return {
      ...omit(out, 'session', 'blocks', 'actions'),
      input: { ...omit(out.input!, 'session'), values: answers.data!, ...(run ? { session } : {}) },
      response: out.response && { ...omit(out.response, 'actionId'), values: flat },
      ...(run ? { session: omit({ ...run, attachments: undefined }) } : {}),
      attachments: files.data || [],
    } as M;
  }
  async #response<M extends Message>(out: M, request: SealedEnvelope, env: SealedEnvelope) {
    const expect = {
      t: 'response',
      message: out.id,
      request: await e2ee.envelopeDigest(request),
      team: out.team,
    };
    const { values, actionId, attachments } = await this.#open(env, expect, KeyedSession.#identity);
    const answers = answersSchema.safeParse(values);
    const files = fileList.safeParse(attachments);
    if (
      !answers.success ||
      !files.success ||
      (actionId !== undefined && typeof actionId !== 'string')
    )
      return fail('Malformed answer.');
    const action = actionId as string | undefined;
    const valid = action
      ? matchesAction(out.actions, action, answers.data)
      : !(out.actions?.length && !out.fields.length) &&
        !Object.keys(validateAnswers(out.fields, answers.data, out.response!.secretFields)).length;
    if (!valid) fail('The answer does not match the request.');
    this.#learn(files.data);
    const answer = (files.data || []).filter((f) => !out.attachments.some((a) => a.id === f.id));
    // Verified: the signer is this member of the request's team.
    const by = (await this.state()).ws ? (env.ctx.member as string) : undefined;
    return {
      ...out,
      ...(by ? { answeredBy: by } : {}),
      response: omit({ ...out.response!, values: answers.data, actionId: action, by }),
      attachments: [...out.attachments, ...answer],
    };
  }
  /**
   * Opens a task's log lines; only the integration running the task may sign them. `task`
   * fetches the record when this session has not opened it yet.
   */
  async openLogs(id: string, logs: TaskLog[], task: () => Promise<Message>): Promise<OpenedLog[]> {
    if (!logs.length) return logs;
    if (!this.#runners.has(id)) await this.openRecord(await task(), { task: true });
    const runner = this.#runners.get(id);
    return Promise.all(
      logs.map(async (log): Promise<OpenedLog> => {
        try {
          if (!log.sealed) fail('This log line is not end-to-end encrypted.');
          const expect = { t: 'log', task: id, seq: log.sequence, team: this.#teams.get(id) };
          const signer = KeyedSession.#integration(runner);
          const { text } = await this.#open(log.sealed!, expect, signer);
          return typeof text === 'string' ? { ...log, text, e2ee: true } : fail('Malformed log.');
        } catch (error) {
          if (!(error instanceof E2eeError)) throw error;
          return {
            ...log,
            text: '',
            e2ee: true,
            [error.message === NO_ENTRY ? 'locked' : 'unverified']: true,
          };
        }
      }),
    );
  }
  /** Seals log text (at most 4,096 characters per line) and the error of a task update. */
  async sealUpdate(
    task: string,
    update: { error?: string; logs?: TaskLog[] } & Payload,
    record?: () => Promise<Message>,
  ) {
    const s = await this.state();
    const team = await this.teamOf(task, record);
    const { error, logs, ...rest } = update;
    const seal = async (payload: Payload, ctx: Record<string, string | number> & { t: string }) => {
      const env = await e2ee.seal({
        payload,
        ctx: { ...ctx, account: s.account, ...(team ? { team } : {}) },
        signer: s.me,
        to: this.#to(s, team),
      });
      return JSON.stringify(env).length > ENVELOPE_LIMIT
        ? fail('A sealed log line is too large.')
        : env;
    };
    const out: Payload = { ...rest };
    if (logs)
      out.logs = await Promise.all(
        logs.map(async ({ sequence, stream, text, sealed }) => {
          if (sealed) return { sequence, stream, text: '', sealed };
          if (text.length > 4096) fail('Log lines hold at most 4,096 characters.');
          return {
            sequence,
            stream,
            text: '',
            sealed: await seal({ text }, { t: 'log', task, seq: sequence }),
          };
        }),
      );
    if (error !== undefined) out.errorSealed = await seal({ error }, { t: 'result', task });
    return out;
  }
  /**
   * Seals a Fleet unit's state for `world` under `key`, to the account inbox or, in a team
   * workspace, to this connection's default team. Envelopes over 6,000 characters are refused.
   */
  async sealUnit(world: string, key: string, state: UnitStateInput): Promise<SealedEnvelope> {
    if (!unitKeySchema.safeParse(key).success)
      throw new HeraldError('Unit keys are 1-64 letters, digits, _ or -.', 400);
    const parsed = unitStateSchema.safeParse(state);
    if (!parsed.success) throw new HeraldError(z.prettifyError(parsed.error), 400);
    const s = await this.state();
    const team = this.#team(s);
    const payload: UnitState = parsed.data;
    const env = await e2ee.seal({
      payload,
      ctx: { t: 'fleet-unit', account: s.account, world, key, ...(team ? { team } : {}) },
      signer: s.me,
      to: this.#to(s, team),
    });
    if (JSON.stringify(env).length > unitEnvelopeChars)
      throw new HeraldError(
        `Unit ${key} is too large: its sealed state exceeds ${unitEnvelopeChars.toLocaleString('en')} characters. Shorten the task or file paths.`,
        400,
      );
    return env;
  }
  /** A secret answer sealed by the account to this integration only. */
  /** A secret field's text, or a secret file field's attachments (their keys are learned). */
  async openSecret(
    message: string,
    field: string,
    env: SealedEnvelope,
    record?: () => Promise<Message>,
  ): Promise<string | FileAttachment[]> {
    const expect = { t: 'secret', message, field, team: await this.teamOf(message, record) };
    const { value, files } = await this.#open(env, expect, KeyedSession.#identity);
    if (typeof value === 'string') return value;
    const list = fileList.safeParse(files);
    if (!files || !list.success || !list.data!.length) fail('Malformed secret.');
    this.#learn(list.data);
    return list.data!;
  }
  /** Checks that the account identity signed a claimed secret receiver's one-time key. */
  async checkReceiver<
    R extends { claimId?: string; publicKey?: unknown; sig?: string; member?: string },
  >(message: string, receiver: R, record?: () => Promise<Message>): Promise<R> {
    if (!receiver.claimId || !receiver.publicKey) return receiver;
    if (!receiver.sig) fail('The secret receiver is not signed by the account.');
    const { identity, ws } = await this.state();
    const { claimId, publicKey, member } = receiver;
    if (!ws) {
      await e2ee.verifyReceiver(receiver.sig!, identity, { message, claimId, publicKey });
      return receiver;
    }
    // A team member of the request's team claims it, signing with their personal identity.
    const signer = e2ee.teamMember(ws, member, await this.teamOf(message, record));
    await e2ee.verifyReceiver(receiver.sig!, signer.identity, {
      message,
      claimId,
      publicKey,
      member,
    });
    return receiver;
  }
}
