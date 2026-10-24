import WebSocket from 'ws';
import type {
  Account,
  Answers,
  Attachment,
  Destination,
  DestinationRegistration,
  Envelope,
  Certificate,
  Integration,
  KeyDirectory,
  Message,
  MessageFilter,
  MessageRequest,
  Scope,
  SealedEnvelope,
  TaskLog,
  ThreadPage,
} from './schema/index.js';
import {
  E2eeError,
  fileKey,
  openFile,
  parseToken,
  parseWorkspacePin,
  sealedSize,
  sealFile,
  type WorkspacePin,
} from './e2ee/index.js';
import { KeyedSession, type FileAttachment, type OpenedLog, type WorkspaceInfo } from './keyed.js';
import { HeraldError, parseRetryAfter, readError, readJson, retryDelay, sleep } from './http.js';
import { version } from './version.js';
import { LiveSocket, type LiveEvent } from './socket.js';
import { idleBody, type UploadData } from './upload.js';
export type {
  Account,
  Answers,
  Attachment,
  Destination,
  DestinationRegistration,
  Envelope,
  Field,
  Integration,
  KeyDirectory,
  Message,
  MessageFilter,
  MessageInput,
  MessageRequest,
  MessageStatus,
  RequestType,
  Scope,
  SessionOptions,
  SessionRequest,
  Task,
  TaskLog,
  ThreadPage,
} from './schema/index.js';
export { createKeys, seal, unseal } from './schema/crypto.js';
export { HeraldError, parseRetryAfter } from './http.js';
export { E2eeError } from './e2ee/index.js';
export type { FileAttachment, OpenedLog, WorkspaceInfo } from './keyed.js';
export type { WorkspacePin } from './e2ee/index.js';
export { backoff, LiveSocket } from './socket.js';
export type { LiveEvent } from './socket.js';
export type { UploadData } from './upload.js';
export { version } from './version.js';
/** `GET /api/ping`: a public liveness check. */
export type Ping = { ok: true; channel: string; version: string };
/** The calling integration token (`GET /token`). */
export type TokenInfo = {
  id: string;
  name: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
  account: { email: string; name: string };
};
export type MessageQuery = MessageFilter & {
  /** Revision feed: changes after this revision, ascending. */
  after?: number;
  /** Older page: `createdAt|id` of the last message seen. */
  before?: string;
  search?: string;
  tombstones?: 1;
};
/** A streamed file download; read `body` once, or call `bytes()`. */
export type FileDownload = {
  name: string;
  type: string;
  size?: number;
  body: ReadableStream<Uint8Array>;
  bytes(): Promise<Uint8Array>;
};
export type WaitOptions = { waitTimeout?: number; signal?: AbortSignal };
export type AskInput = MessageRequest & { timeout?: number | string; idempotencyKey?: string };
export type ActionAnswer<T extends Answers = Answers> = { actionId: string; values: T };
export type RequestOptions = {
  method?: string;
  idempotencyKey?: string;
  /** @deprecated Use `idempotencyKey`. */
  key?: string;
  signal?: AbortSignal;
  /** `false` returns the first failure, for callers with their own retry policy. */
  retry?: boolean;
  /** Times out only the response headers, so callers can stream long bodies. */
  stream?: boolean;
};
export type UploadOptions = {
  /** Required for streams; arrays and blobs know their size. */
  size?: number;
  /** Seconds without upload progress before aborting (default 60). */
  idleTimeout?: number;
  signal?: AbortSignal;
};
export type TaskClaim = { task: Message; lease: string; leaseExpiresAt?: string };
export type TaskUpdate = {
  lease?: string;
  status?: 'completed' | 'failed';
  error?: string;
  logs?: TaskLog[];
};
export type SecretReceiver = {
  claimId?: string;
  publicKey?: JsonWebKey;
  received?: boolean;
  /** The account identity's signature over the claim, checked by the client. */
  sig?: string;
  /** Team workspaces: the claiming member, whose personal identity signed. */
  member?: string;
};
/** An answered request: values, the chosen action, and in a team workspace who answered. */
export type AskDetails<T extends Answers = Answers> = {
  values: T;
  actionId?: string;
  /** The verified member who answered; team workspaces only. */
  answeredBy?: string;
  message: Message;
};
export type HeraldOptions = {
  apiKey?: string;
  url?: string;
  maxRetryAfter?: number;
  userAgent?: string;
  /** Sent as `Herald-Workspace`; tokens are bound to one workspace, so this is optional. */
  workspace?: string;
  /**
   * The newest workspace chain head and roster this token verified, from earlier runs; defaults to
   * `HERALD_PIN` (the pin as JSON). Without one, a fresh client trusts the newest chain and roster
   * the server shows under the token's root (see the e2ee spec's limitations).
   */
  pin?: WorkspacePin;
  /** Called with a newer verified pin, to store it with the token (and in `HERALD_PIN`). */
  onPin?: (pin: WorkspacePin) => void;
};
export function duration(value: number | string): number {
  const match = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) throw new Error('Use seconds or a duration such as 10m.');
  const seconds = Number(match[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[match[2] || 's']!;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400)
    throw new Error('Duration must be between zero and 24 hours.');
  return seconds;
}
const RETRIES = 2;
const UNKEYED =
  'This token has no end-to-end key. Create a new token in Herald (Settings → Connections) or run herald login.';
const path = (id: string) => encodeURIComponent(id);
const stale = (error: unknown) =>
  error instanceof HeraldError && error.status === 409 && error.code === 'E2EE_STALE_KEY';
export class Herald {
  readonly base: string;
  readonly apiKey: string;
  /** Longest server Retry-After, in seconds, that a request waits out before failing. */
  readonly maxRetryAfter: number;
  /** Sent as `User-Agent`; defaults to `herald-sdk-ts/<version>`. */
  readonly userAgent: string;
  /** Sent as `Herald-Workspace` when set. */
  readonly workspaceId?: string;
  #live?: LiveSocket;
  #keyed?: KeyedSession;
  constructor(options: HeraldOptions = {}) {
    this.base = (options.url || process.env.HERALD_URL || 'https://app.herald.run').replace(
      /\/$/,
      '',
    );
    const url = new URL(this.base);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    )
      throw new Error('Use HTTPS for Herald.');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error('Use a server origin without credentials, path, query or fragment.');
    const token = (
      options.apiKey ||
      process.env.HERALD_API_KEY ||
      process.env.HERALD_TOKEN ||
      ''
    ).trim();
    // Connection tokens are `hdr_<auth>.<seed>.<fingerprint>`; only `hdr_<auth>` leaves the process.
    // Human session tokens carry no key and reach only account, key and connection routes.
    const keyed = token.startsWith('hdr_') || /\.[\w-]{43}\.[\w-]{22}$/.test(token);
    const parsed = keyed ? parseToken(token) : undefined;
    if (parsed && !parsed.seed) throw new E2eeError(UNKEYED);
    this.apiKey = parsed?.auth ?? token;
    if (parsed?.seed)
      this.#keyed = new KeyedSession(
        parsed.seed,
        parsed.fingerprint!,
        () => this.request('/keys'),
        {
          pin:
            options.pin ??
            (process.env.HERALD_PIN ? parseWorkspacePin(process.env.HERALD_PIN) : undefined),
          onPin: options.onPin,
        },
      );
    this.workspaceId = options.workspace;
    this.maxRetryAfter = options.maxRetryAfter ?? 60;
    this.userAgent = options.userAgent || `herald-sdk-ts/${version}`;
  }
  /** The account safety code the token is pinned to. */
  get fingerprint(): string | undefined {
    return this.#keyed?.fingerprint;
  }
  /** Content is end-to-end encrypted, so content calls need a connection token's key. */
  get #keys(): KeyedSession {
    if (!this.#keyed) throw new E2eeError(UNKEYED);
    return this.#keyed;
  }
  // Tombstones from the revision feed carry no content to open.
  #open = async <M extends Message>(m: M): Promise<M> =>
    (m as { deleted?: unknown }).deleted === true ? m : this.#keys.openRecord(m);
  #openTask = async <M extends Message>(m: M): Promise<M> =>
    this.#keys.openRecord(m, { task: true });
  /**
   * Opens a task delivered outside this client, such as a webhook's `task`; one without sealed
   * input is `unverified`.
   */
  openTask(task: Message): Promise<Message> {
    return this.#openTask(task);
  }
  #headers(extra: Record<string, string> = {}) {
    return {
      Authorization: 'Bearer ' + this.apiKey,
      'User-Agent': this.userAgent,
      'X-Herald-Client': `sdk/${version}`,
      ...(this.workspaceId ? { 'Herald-Workspace': this.workspaceId } : {}),
      ...extra,
    };
  }
  /**
   * The team workspace this token belongs to (id, epoch, the teams it may address), or
   * undefined for a personal account.
   */
  async workspace(): Promise<WorkspaceInfo | undefined> {
    return this.#keys.workspace();
  }
  /** Seals and posts; after `409 E2EE_STALE_KEY` reloads the keys and reseals once. */
  async #sealed<T>(post: () => Promise<T>): Promise<T> {
    try {
      return await post();
    } catch (error) {
      if (!stale(error)) throw error;
      await this.#keys.state('force');
      return post();
    }
  }
  /**
   * Calls `/api/v1` + `path`. Reads and keyed writes retry network errors and 5xx; any request
   * retries a rate limit that sends Retry-After, since the server rejected it unprocessed.
   */
  async request<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const response = await this.#fetch('/api/v1' + path, body, options);
    return readJson<T>(response, parseRetryAfter(response.headers.get('Retry-After')));
  }
  async #fetch(path: string, body: unknown, options: RequestOptions): Promise<Response> {
    const key = options.idempotencyKey ?? options.key;
    const safe = body === undefined || !!key;
    const retries = options.retry === false ? 0 : RETRIES;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      const headers = new AbortController();
      const timer = options.stream
        ? setTimeout(() => headers.abort(new Error('Herald request timed out.')), 15000)
        : undefined;
      try {
        response = await fetch(this.base + path, {
          method: options.method || (body === undefined ? 'GET' : 'POST'),
          headers: this.#headers({
            'Content-Type': 'application/json',
            ...(key ? { 'Idempotency-Key': key } : {}),
          }),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: options.signal ?? (options.stream ? headers.signal : AbortSignal.timeout(15000)),
          redirect: 'manual',
        });
      } catch (error) {
        if (attempt >= retries || options.signal?.aborted || !safe) throw error;
        await sleep(retryDelay(attempt), options.signal);
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new HeraldError('Herald does not accept API redirects.', response.status);
      }
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
      const retryable =
        response.status === 429 ? safe || retryAfter !== undefined : response.status >= 500 && safe;
      if (retryable && attempt < retries && (retryAfter ?? 0) <= this.maxRetryAfter) {
        await response.body?.cancel();
        await sleep(
          retryAfter === undefined ? retryDelay(attempt) : retryAfter * 1000,
          options.signal,
        );
        continue;
      }
      return response;
    }
  }
  /** Public liveness check: `{ok, channel, version}`; needs no token. */
  async ping(): Promise<Ping> {
    const response = await this.#fetch('/api/ping', undefined, {});
    return readJson<Ping>(response);
  }
  /** The calling token's name, scopes and account. */
  token(): Promise<TokenInfo> {
    return this.request('/token');
  }
  /** Revokes the calling token; later requests with it fail with 401. */
  revokeToken(): Promise<void> {
    return this.request('/token', undefined, { method: 'DELETE' });
  }
  /** Plan, usage and limits of the token's account. */
  account(): Promise<Account> {
    return this.request('/account');
  }
  /** Sends a message; it is validated locally and its content sealed first. */
  async send(
    input: MessageRequest,
    options: string | { idempotencyKey?: string } = crypto.randomUUID(),
  ): Promise<Message> {
    const idempotencyKey =
      (typeof options === 'string' ? options : options.idempotencyKey) || crypto.randomUUID();
    const post = async () => {
      const body = await this.#keys.sealMessage(input, idempotencyKey);
      return this.request<Message>('/messages', body, { idempotencyKey });
    };
    return this.#open(await this.#sealed(post));
  }
  async get(id: string): Promise<Message> {
    return this.#open(await this.request<Message>('/messages/' + path(id)));
  }
  async thread(id: string, after = 0): Promise<ThreadPage> {
    const page = await this.request<ThreadPage>(`/messages/${path(id)}/thread?after=${after}`);
    return { ...page, messages: await Promise.all(page.messages.map(this.#open)) };
  }
  async *threadMessages(id: string): AsyncGenerator<Message> {
    let after = 0;
    while (true) {
      const page = await this.thread(id, after);
      for (const message of page.messages) yield message;
      if (page.next === undefined) return;
      after = page.next;
    }
  }
  /**
   * One page of the revision feed (`after`), or messages matching a filter. The server searches
   * sender names only; filter opened pages for content.
   */
  async messages(query: MessageQuery = {}): Promise<Message[]> {
    const search = new URLSearchParams(
      Object.entries(query).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
    ).toString();
    const page = await this.request<Message[]>('/messages' + (search ? '?' + search : ''));
    return Promise.all(page.map(this.#open));
  }
  /** Cancels a pending request this integration sent. */
  async cancel(id: string): Promise<Message> {
    const keys = this.#keys;
    return keys.openRecord(await this.request<Message>(`/messages/${path(id)}/cancel`, {}));
  }
  /** A task's retained log lines after `after` (a sequence number); sealed lines are opened. */
  async taskLogs(id: string, options: { after?: number } = {}): Promise<OpenedLog[]> {
    const query = options.after === undefined ? '' : `?after=${options.after}`;
    const page = await this.request<{ logs: TaskLog[] }>(`/messages/${path(id)}/logs${query}`);
    return this.#keys.openLogs(id, page.logs, () => this.request<Message>('/messages/' + path(id)));
  }
  /**
   * Streams and decrypts an attachment's bytes. Pass the attachment from an opened record, or its
   * ID once this client has seen it.
   */
  async download(
    file: string | FileAttachment,
    options: { signal?: AbortSignal } = {},
  ): Promise<FileDownload> {
    const id = typeof file === 'string' ? file : file.id;
    const known = typeof file === 'string' ? this.#keys.files.get(file) : file;
    if (!known?.key)
      throw new E2eeError('Download a file through an attachment of an opened record.');
    const response = await this.#fetch('/api/v1/files/' + path(id), undefined, {
      ...options,
      stream: true,
    });
    if (!response.ok) await readError(response, 'File download failed.');
    if (!response.body) throw new HeraldError('Herald returned no file body.', response.status);
    const body = openFile(known.key, response.body);
    return {
      name: known.name,
      type: known.type,
      size: known.size,
      body,
      bytes: async () => new Uint8Array(await new Response(body).arrayBuffer()),
    };
  }
  /** Creates a destination, or updates the one registered with the same `key`. */
  register(input: DestinationRegistration): Promise<Destination & { signingSecret?: string }> {
    return this.request('/destinations', input);
  }
  /** This integration's destinations. */
  destinations(): Promise<Destination[]> {
    return this.request('/destinations');
  }
  updateDestination(id: string, input: DestinationRegistration): Promise<Destination> {
    return this.request('/destinations/' + path(id), input, { method: 'PUT' });
  }
  /** Removes a destination and cancels its queued tasks. */
  deleteDestination(id: string): Promise<{ ok: true }> {
    return this.request('/destinations/' + path(id), undefined, { method: 'DELETE' });
  }
  /** Replaces a webhook destination's signing secret, returned once. */
  rotateDestinationSecret(id: string): Promise<Destination & { signingSecret: string }> {
    return this.request(`/destinations/${path(id)}/secret`, {});
  }
  /** Human sessions only: the account's connections. */
  integrations(): Promise<Integration[]> {
    return this.request('/integrations');
  }
  /** Human sessions only; the token is returned once. Not retried, so it never creates two. */
  createIntegration(input: {
    name: string;
    scopes: Scope[];
    /** Certifies the connection's end-to-end key. */
    certificate: Certificate;
  }): Promise<{ token: string; integration: Integration }> {
    return this.request('/integrations', input);
  }
  /**
   * The account's end-to-end key directory: signed statement and connection certificates. A
   * connection token loads it once and verifies it against its safety code before any sealed call.
   */
  async keys(): Promise<KeyDirectory> {
    return this.#keyed ? (await this.#keyed.state()).directory : this.request('/keys');
  }
  /** Human sessions only: the certificate an owner approved for a device login, once. */
  deviceCertificate(userCode: string): Promise<Certificate> {
    return this.request('/keys/device-code/' + path(userCode));
  }
  /** Human sessions only: revokes the token and removes the connection's destinations. */
  deleteIntegration(id: string): Promise<{ ok: true }> {
    return this.request('/integrations/' + path(id), undefined, { method: 'DELETE' });
  }
  /** `heartbeat: true` asks for a lease that lapses unless renewed with `heartbeatTask`. */
  async claimTask(
    id: string,
    input: { runnerId: string; heartbeat?: boolean },
  ): Promise<TaskClaim> {
    const keys = this.#keys;
    const claim = await this.request<TaskClaim>(`/tasks/${path(id)}/claim`, input);
    return { ...claim, task: await keys.openRecord(claim.task, { task: true }) };
  }
  heartbeatTask(id: string, lease: string): Promise<{ lease: string; leaseExpiresAt: string }> {
    return this.request(`/tasks/${path(id)}/heartbeat`, { lease });
  }
  /** Reports logs and/or the outcome, both sealed; log batches retry safely. */
  async updateTask(
    id: string,
    update: TaskUpdate,
    options: Pick<RequestOptions, 'idempotencyKey' | 'retry'> = {},
  ): Promise<Message> {
    const record = () => this.request<Message>('/messages/' + path(id));
    const post = async () => {
      const body = await this.#keys.sealUpdate(id, update, record);
      return this.request<Message>(`/tasks/${path(id)}/update`, body, options);
    };
    return this.#openTask(await this.#sealed(post));
  }
  /** Consumes the encrypted envelopes of an answered request's secret fields. */
  collectSecrets(id: string): Promise<Record<string, Envelope | SealedEnvelope>> {
    return this.request(`/messages/${path(id)}/secrets`, {});
  }
  /**
   * `collectSecrets`, decrypted with this client's key: text for secret fields, attachments for
   * secret file fields. `download` those within 15 minutes of the answer; then they are deleted.
   */
  async revealSecrets(id: string): Promise<Record<string, string | FileAttachment[]>> {
    const keys = this.#keys;
    const envelopes = await this.collectSecrets(id);
    const values: Record<string, string | FileAttachment[]> = {};
    for (const [field, envelope] of Object.entries(envelopes)) {
      if (!('ct' in envelope)) throw new E2eeError('This secret is not end-to-end encrypted.');
      values[field] = await keys.openSecret(id, field, envelope, () =>
        this.request<Message>('/messages/' + path(id)),
      );
    }
    return values;
  }
  /**
   * For a `kind: 'secret'` offer: the receiver's claim and public key once a device claims it.
   * Only a key the account identity signed is accepted.
   */
  async secretReceiver(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SecretReceiver> {
    const keys = this.#keys;
    const receiver = await this.request<SecretReceiver>(
      `/messages/${path(id)}/secret-receiver`,
      undefined,
      options,
    );
    return keys.checkReceiver(id, receiver, () => this.request<Message>('/messages/' + path(id)));
  }
  /** Deposits the value sealed to the claimed receiver's key; repeating the same deposit is safe. */
  deliverSecret(
    id: string,
    input: { claimId: string; envelope: Envelope },
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    return this.request(`/messages/${path(id)}/secret-delivery`, input, options);
  }
  async ask<T extends Answers = Answers>(input: AskInput, options: WaitOptions = {}): Promise<T> {
    return (await this.answer(input, options)).response!.values as T;
  }
  /** Like `ask`, with the chosen action, the record and, in a team workspace, who answered. */
  async askDetails<T extends Answers = Answers>(
    input: AskInput,
    options: WaitOptions = {},
  ): Promise<AskDetails<T>> {
    const message = await this.answer(input, options);
    const { values, actionId } = message.response!;
    return { values: values as T, actionId, answeredBy: message.answeredBy, message };
  }
  async askAction<T extends Answers = Answers>(
    input: AskInput & { actions: NonNullable<MessageRequest['actions']> },
    options: WaitOptions = {},
  ): Promise<ActionAnswer<T>> {
    if (!input.actions?.length) throw new Error('askAction requires declared actions.');
    const result = await this.answer(input, options);
    const response = result.response;
    if (!response?.actionId || !input.actions.some((action) => action.id === response.actionId))
      throw new HeraldError('The response does not identify a declared action.', 502, result.id);
    return { actionId: response.actionId, values: response.values as T };
  }
  private async answer(input: AskInput, options: WaitOptions): Promise<Message> {
    const { timeout, idempotencyKey, ...message } = input;
    if (timeout !== undefined && (message.expiresAt || message.expiresIn))
      throw new Error('Use timeout or expiresAt, not both.');
    if (timeout !== undefined) message.expiresIn = duration(timeout);
    const sent = await this.send({ ...message, kind: 'form' }, idempotencyKey);
    const result = await this.wait(sent.id, options);
    if (result.status !== 'answered')
      throw new HeraldError(`Request ${result.status}.`, 410, sent.id);
    if (result.locked || result.unverified)
      throw new HeraldError('The answer could not be verified.', 502, sent.id);
    return result;
  }
  /** The shared live socket; every `wait` and `watch` on this client subscribes to it. */
  get live(): LiveSocket {
    return (this.#live ??= new LiveSocket(
      () =>
        new WebSocket(this.base.replace(/^http/, 'ws') + '/ws', {
          headers: this.#headers(),
          followRedirects: false,
        }),
    ));
  }
  async wait(id: string, options: WaitOptions = {}): Promise<Message> {
    const seconds = duration(options.waitTimeout ?? 3600);
    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | undefined,
        fallback: ReturnType<typeof setTimeout> | undefined,
        revision = -1,
        done = false,
        checking = false,
        again = false;
      const finish = (message?: Message, error?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        clearTimeout(fallback);
        unsubscribe?.();
        options.signal?.removeEventListener('abort', abort);
        if (message) resolve(message);
        else reject(error);
      };
      const abort = () => finish(undefined, options.signal?.reason || new Error('Aborted.'));
      const check = async () => {
        if (done) return;
        // An event during a check may postdate its read, so it earns one more.
        if (checking) return void (again = true);
        checking = true;
        try {
          const message = await this.get(id);
          if (['answered', 'expired', 'cancelled'].includes(message.status)) finish(message);
        } catch (e) {
          if (e instanceof HeraldError && e.status < 500 && e.status !== 429) finish(undefined, e);
        } finally {
          checking = false;
          if (again) {
            again = false;
            void check();
          }
        }
      };
      // The fallback poll is slow while the socket delivers events, faster while it is down.
      const poll = () => {
        clearTimeout(fallback);
        if (done) return;
        fallback = setTimeout(
          () => {
            poll();
            void check();
          },
          this.live.connected ? 300_000 : 30_000,
        );
      };
      const wake = (event: LiveEvent) => {
        if (event.type === 'open' || event.type === 'close') poll();
        if (event.type === 'close' || event.type === 'event') return;
        if (event.type === 'sync' && event.revision !== undefined) {
          if (event.revision <= revision) return;
          revision = event.revision;
        }
        void check();
      };
      const timeout = setTimeout(
        () =>
          finish(
            undefined,
            new HeraldError(
              'Wait timed out; the request remains available. Resume with its message ID.',
              408,
              id,
            ),
          ),
        seconds * 1000,
      );
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      else {
        unsubscribe = this.live.subscribe(wake);
        poll();
        void check();
      }
    });
  }
  watch(
    onMessage: (message: Message) => Promise<void> | void,
    options: { after?: number; signal?: AbortSignal } = {},
  ): () => void {
    let cursor = options.after ?? 0,
      stopped = false,
      refreshing = false,
      dirty = false,
      unsubscribe: (() => void) | undefined,
      refreshTimer: ReturnType<typeof setTimeout> | undefined;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Use a nonnegative revision.');
    const refresh = async () => {
      dirty = true;
      if (refreshing || stopped) return;
      refreshing = true;
      try {
        while (dirty && !stopped) {
          dirty = false;
          const page = await this.messages({ after: cursor });
          for (const m of page) {
            await onMessage(m);
            cursor = Math.max(cursor, m.revision || 0);
          }
          if (page.length === 100) dirty = true;
        }
      } catch {
        if (!stopped) {
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(refresh, 3000);
        }
      } finally {
        refreshing = false;
      }
    };
    const stop = () => {
      stopped = true;
      clearTimeout(refreshTimer);
      unsubscribe?.();
      options.signal?.removeEventListener('abort', stop);
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    else {
      unsubscribe = this.live.subscribe((event) => {
        if (event.type !== 'close') void refresh();
      });
      void refresh();
    }
    return stop;
  }
  /**
   * Encrypts, reserves and uploads a file; streams abort only after `idleTimeout` without
   * progress. Returns the attachment with its `key`, which `send` seals in.
   */
  async upload(
    name: string,
    data: UploadData,
    type = 'application/octet-stream',
    options: UploadOptions = {},
  ): Promise<FileAttachment> {
    const size =
      data instanceof Uint8Array
        ? data.byteLength
        : data instanceof Blob
          ? data.size
          : options.size;
    if (size === undefined || !Number.isSafeInteger(size) || size < 0)
      throw new Error('Pass the byte size for streamed uploads.');
    const keys = this.#keys;
    const key = fileKey();
    const sent = sealedSize(size);
    const reserve = { name: 'encrypted', type: 'application/octet-stream', size: sent };
    const file = await this.request<Attachment>('/files', reserve);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal!.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    const source = sealFile(key, plainStream(data));
    const { body, done } = idleBody(source, (options.idleTimeout ?? 60) * 1000, controller);
    try {
      const response = await fetch(this.base + '/api/v1/files/' + path(file.id), {
        method: 'PUT',
        headers: this.#headers({ 'Content-Length': String(sent) }),
        body,
        duplex: 'half',
        redirect: 'manual',
        signal: controller.signal,
      } as RequestInit);
      if (!response.ok) await readError(response, 'File upload failed.');
      await response.body?.cancel();
      const attachment = { id: file.id, name, size, type, key };
      keys.files.set(file.id, attachment);
      return attachment;
    } finally {
      done();
      options.signal?.removeEventListener('abort', abort);
    }
  }
}
/** Upload data as a stream for `sealFile`. */
const plainStream = (data: UploadData): Uint8Array | ReadableStream<Uint8Array> =>
  data instanceof Uint8Array
    ? data
    : data instanceof Blob
      ? data.stream()
      : iterableStream(data[Symbol.asyncIterator]());
const iterableStream = (iterator: AsyncIterator<Uint8Array>) =>
  new ReadableStream<Uint8Array>({
    async pull(stream) {
      const next = await iterator.next();
      if (next.done) stream.close();
      else stream.enqueue(next.value);
    },
    cancel: () => void iterator.return?.(),
  });
export { verifyWebhook } from './webhook.js';
