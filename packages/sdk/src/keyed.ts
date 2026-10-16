import { z } from 'zod';
import * as e2ee from './e2ee/index.js';
import { E2eeError, type KeySet, type RecipientKey, type SealedEnvelope } from './e2ee/index.js';
import {
  answersSchema,
  matchesAction,
  messageInputSchema,
  sealedMessageInputSchema,
  sessionInputSchema,
  sessionValues,
  validateAnswers,
  type Attachment,
  type KeyDirectory,
  type Message,
  type MessageRequest,
  type SealedMessageInput,
  type TaskLog,
} from './schema/index.js';
import { HeraldError } from './http.js';
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
};
type Payload = Record<string, unknown>;
const NO_ENTRY = 'No recipient entry for these keys.';
const SECRET_KEY = 'Secret fields require a requester public key.';
// Keyed requests receive secrets sealed to the integration key, so no RSA key is needed.
const placeholderKey = { kty: 'RSA', n: 'A'.repeat(342), e: 'AQAB' } as const;
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
/** `messageInputSchema`, without the requester key that keyed secret fields do not use. */
function parseInput(input: MessageRequest) {
  let result = messageInputSchema.safeParse(input);
  if (!result.success && result.error.issues.some((i) => i.message === SECRET_KEY))
    result = messageInputSchema.safeParse({ ...input, publicKey: placeholderKey });
  return result;
}
/** A shallow copy without `keys` and without undefined values. */
function omit<T extends object>(value: T, ...keys: string[]): T {
  const entries = Object.entries(value).filter(([k, v]) => v !== undefined && !keys.includes(k));
  return Object.fromEntries(entries) as T;
}
/** Placeholder content for a record that could not be opened. */
function strip<M extends Message>(m: M, flag: 'locked' | 'unverified'): M {
  const out: Message = { ...omit(m, 'blocks', 'actions', 'session'), e2ee: true, [flag]: true };
  if (m.sealed) Object.assign(out, { title: 'Encrypted message', body: '', fields: [] });
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
  constructor(seed: string, fingerprint: string, directory: () => Promise<KeyDirectory>) {
    this.seed = seed;
    this.fingerprint = fingerprint;
    this.#directory = directory;
  }
  /** The verified key directory, fetched once; `refresh` refetches at most every 10 s. */
  state(refresh = false): Promise<State> {
    if (!this.#state || (refresh && Date.now() - this.#loaded > 10_000)) {
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
    if (!directory.account)
      fail(
        'End-to-end encryption is not set up for this account; a keyed token never uses plaintext.',
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
    };
  }
  #to = (s: State): RecipientKey[] => [s.inbox, { kid: s.me.kid, box: s.me.boxPub }];
  async #open<T extends Payload>(
    env: SealedEnvelope,
    expect: Record<string, string | number> & { t: string },
    by: 'identity' | 'integration',
  ): Promise<T> {
    let s = await this.state();
    if (by === 'integration' && !s.signers.has(env.from)) s = await this.state(true);
    return e2ee.open<T>(env, {
      recipients: [s.me],
      signers: (kid) =>
        by === 'identity' ? (kid === s.identityKid ? s.identity : undefined) : s.signers.get(kid),
      expect: { ...expect, account: s.account },
    });
  }
  #learn(files: FileAttachment[] = []) {
    for (const file of files) if (file.key) this.files.set(file.id, file);
  }
  /** Seals a message request; secret offers stay metadata only, as the server delivers them. */
  async sealMessage(input: MessageRequest): Promise<SealedMessageInput | MessageRequest> {
    if (input.kind === 'secret') return input;
    const parsed = parseInput(input);
    if (!parsed.success) throw new HeraldError(z.prettifyError(parsed.error), 400);
    const data = parsed.data as Exclude<typeof parsed.data, { kind: 'secret' }>;
    const s = await this.state();
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
    const sealed = await e2ee.seal({
      payload,
      ctx: { t: 'message', account: s.account },
      signer: s.me,
      to: this.#to(s),
    });
    return sealedMessageInputSchema.parse({
      sealed,
      digest: await e2ee.idempotencyDigest(this.seed, payload),
      asks: data.kind === 'form' || !!data.fields.length || !!data.actions?.length,
      attachments: attachments.map(({ id }) => ({ id })),
      taskId: data.taskId,
      replyTo: data.replyTo,
      expiresAt: data.expiresAt,
      expiresIn: data.expiresIn,
    });
  }
  /** Opens a record's sealed parts into a plain record with `e2ee: true`; failures are flagged. */
  async openRecord<M extends Message>(m: M): Promise<M> {
    const results = [m?.result?.sealed, m?.execution?.sealed];
    if (!m?.sealed && !m?.input?.sealed && !m?.response?.sealed && !results.some(Boolean)) return m;
    const s = await this.state();
    try {
      let out: M = { ...m, e2ee: true };
      if (m.sealed) out = await this.#content(out, m.sealed, s);
      if (m.input?.sealed) out = await this.#task(out, m.input.sealed);
      if (m.response?.sealed) {
        if (!m.sealed) fail('A sealed answer needs a sealed request.');
        out = await this.#response(out, m.sealed!, m.response.sealed);
      }
      for (const key of ['result', 'execution'] as const) {
        const env = m[key]?.sealed;
        if (!env) continue;
        const { error } = await this.#open(env, { t: 'result', task: m.id }, 'integration');
        if (error !== undefined && typeof error !== 'string') fail('Malformed task result.');
        out = { ...out, [key]: omit({ ...out[key], error }) };
      }
      return out;
    } catch (error) {
      if (!(error instanceof E2eeError)) throw error;
      return strip(m, error.message === NO_ENTRY ? 'locked' : 'unverified');
    }
  }
  async #content<M extends Message>(out: M, env: SealedEnvelope, s: State): Promise<M> {
    const sender = out.senderId && s.kids.get(out.senderId);
    if (sender && sender !== env.from) fail('The message signer is not its sender.');
    const { attachments, ...rest } = await this.#open(env, { t: 'message' }, 'integration');
    const files = fileList.safeParse(attachments);
    const parsed = parseInput({ ...rest, attachments: files.data } as MessageRequest);
    if (!files.success || !parsed.success) return fail('Malformed message content.');
    this.#learn(files.data);
    const content: Payload = {};
    for (const key of CONTENT) content[key] = (parsed.data as Payload)[key];
    const ids = new Set(files.data?.map((f) => f.id));
    return {
      ...out,
      ...omit(content),
      attachments: [...(files.data || []), ...out.attachments.filter((f) => !ids.has(f.id))],
    };
  }
  async #task<M extends Message>(out: M, env: SealedEnvelope): Promise<M> {
    const expect = { t: 'task', destination: out.destinationId!, type: out.typeId! };
    const { values = {}, session, attachments } = await this.#open(env, expect, 'identity');
    const answers = answersSchema.safeParse(values);
    const typed = session === undefined ? undefined : sessionInputSchema.safeParse(session);
    const files = fileList.safeParse(attachments);
    if (!answers.success || !files.success || (typed && !typed.success))
      fail('Malformed task input.');
    this.#learn(files.data);
    const ids = new Set(files.data?.map((f) => f.id));
    const run = typed?.data;
    // Like plaintext tasks: flat values for runners reading `response.values`, plus `session`.
    const flat = run ? { ...answers.data!, ...sessionValues(run) } : answers.data!;
    return {
      ...out,
      input: { ...out.input!, values: answers.data!, ...(run ? { session } : {}) },
      response: out.response && { ...out.response, values: flat },
      ...(run ? { session: omit({ ...run, attachments: undefined }) } : {}),
      attachments: [...(files.data || []), ...out.attachments.filter((f) => !ids.has(f.id))],
    };
  }
  async #response<M extends Message>(out: M, request: SealedEnvelope, env: SealedEnvelope) {
    const expect = { t: 'response', message: out.id, request: await e2ee.envelopeDigest(request) };
    const { values, actionId, attachments } = await this.#open(env, expect, 'identity');
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
    const keyed = new Map(files.data?.map((f) => [f.id, f]));
    return {
      ...out,
      response: omit({ ...out.response!, values: answers.data, actionId: action }),
      attachments: out.attachments.map((f) => keyed.get(f.id) || f),
    };
  }
  async openLogs(task: string, logs: TaskLog[]): Promise<OpenedLog[]> {
    if (!logs.some((log) => log.sealed)) return logs;
    await this.state();
    return Promise.all(
      logs.map(async (log): Promise<OpenedLog> => {
        if (!log.sealed) return log;
        try {
          const expect = { t: 'log', task, seq: log.sequence };
          const { text } = await this.#open(log.sealed, expect, 'integration');
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
  async sealUpdate(task: string, update: { error?: string; logs?: TaskLog[] } & Payload) {
    const s = await this.state();
    const { error, logs, ...rest } = update;
    const seal = async (payload: Payload, ctx: Record<string, string | number> & { t: string }) => {
      const env = await e2ee.seal({
        payload,
        ctx: { ...ctx, account: s.account },
        signer: s.me,
        to: this.#to(s),
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
  /** A secret answer sealed by the account to this integration only. */
  async openSecret(message: string, field: string, env: SealedEnvelope): Promise<string> {
    const { value } = await this.#open(env, { t: 'secret', message, field }, 'identity');
    return typeof value === 'string' ? value : fail('Malformed secret.');
  }
  /** Checks that the account identity signed a claimed secret receiver's one-time key. */
  async checkReceiver<R extends { claimId?: string; publicKey?: unknown; sig?: string }>(
    message: string,
    receiver: R,
  ): Promise<R> {
    if (!receiver.claimId || !receiver.publicKey) return receiver;
    if (!receiver.sig) fail('The secret receiver is not signed by the account.');
    const { identity } = await this.state();
    const { claimId, publicKey } = receiver;
    await e2ee.verifyReceiver(receiver.sig!, identity, { message, claimId, publicKey });
    return receiver;
  }
}
