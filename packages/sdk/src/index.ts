import WebSocket from 'ws';
import type {
  Account,
  Answers,
  Attachment,
  Destination,
  DestinationRegistration,
  Envelope,
  Integration,
  Message,
  MessageFilter,
  MessageRequest,
  Scope,
  TaskLog,
  ThreadPage,
} from './schema/index.js';
import { unseal } from './schema/crypto.js';
import { HeraldError, parseRetryAfter, readError, readJson, retryDelay, sleep } from './http.js';
import { version } from './version.js';
import { LiveSocket } from './socket.js';
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
export { backoff, LiveSocket } from './socket.js';
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
export type SecretReceiver = { claimId?: string; publicKey?: JsonWebKey; received?: boolean };
export function duration(value: number | string): number {
  const match = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) throw new Error('Use seconds or a duration such as 10m.');
  const seconds = Number(match[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[match[2] || 's']!;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400)
    throw new Error('Duration must be between zero and 24 hours.');
  return seconds;
}
const RETRIES = 2;
const path = (id: string) => encodeURIComponent(id);
/** The file name from `Content-Disposition`, without any directory part. */
function fileName(header: string | null): string | undefined {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let name = header?.match(/filename="([^"]*)"/i)?.[1];
  try {
    if (encoded) name = decodeURIComponent(encoded);
  } catch {
    /* Keep the plain filename. */
  }
  return name?.split(/[\\/]/).pop() || undefined;
}
export class Herald {
  readonly base: string;
  readonly apiKey: string;
  /** Longest server Retry-After, in seconds, that a request waits out before failing. */
  readonly maxRetryAfter: number;
  /** Sent as `User-Agent`; defaults to `herald-sdk-ts/<version>`. */
  readonly userAgent: string;
  #live?: LiveSocket;
  constructor(
    options: { apiKey?: string; url?: string; maxRetryAfter?: number; userAgent?: string } = {},
  ) {
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
    this.apiKey = options.apiKey || process.env.HERALD_API_KEY || process.env.HERALD_TOKEN || '';
    this.maxRetryAfter = options.maxRetryAfter ?? 60;
    this.userAgent = options.userAgent || `herald-sdk-ts/${version}`;
  }
  #headers(extra: Record<string, string> = {}) {
    return { Authorization: 'Bearer ' + this.apiKey, 'User-Agent': this.userAgent, ...extra };
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
  send(
    input: MessageRequest,
    options: string | { idempotencyKey?: string } = crypto.randomUUID(),
  ): Promise<Message> {
    const idempotencyKey =
      (typeof options === 'string' ? options : options.idempotencyKey) || crypto.randomUUID();
    return this.request('/messages', input, { idempotencyKey });
  }
  get(id: string): Promise<Message> {
    return this.request('/messages/' + path(id));
  }
  thread(id: string, after = 0): Promise<ThreadPage> {
    return this.request(`/messages/${path(id)}/thread?after=${after}`);
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
  /** One page of the revision feed (`after`), or messages matching a filter. */
  messages(query: MessageQuery = {}): Promise<Message[]> {
    const search = new URLSearchParams(
      Object.entries(query).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
    ).toString();
    return this.request('/messages' + (search ? '?' + search : ''));
  }
  /** Cancels a pending request this integration sent. */
  cancel(id: string): Promise<Message> {
    return this.request(`/messages/${path(id)}/cancel`, {});
  }
  /** A task's retained log lines after `after` (a sequence number). */
  async taskLogs(id: string, options: { after?: number } = {}): Promise<TaskLog[]> {
    const query = options.after === undefined ? '' : `?after=${options.after}`;
    const page = await this.request<{ logs: TaskLog[] }>(`/messages/${path(id)}/logs${query}`);
    return page.logs;
  }
  /** Streams an attachment's bytes. */
  async download(id: string, options: { signal?: AbortSignal } = {}): Promise<FileDownload> {
    const response = await this.#fetch('/api/v1/files/' + path(id), undefined, {
      ...options,
      stream: true,
    });
    if (!response.ok) await readError(response, 'File download failed.');
    if (!response.body) throw new HeraldError('Herald returned no file body.', response.status);
    const body = response.body;
    const length = Number(response.headers.get('Content-Length'));
    return {
      name: fileName(response.headers.get('Content-Disposition')) || id,
      type: response.headers.get('Content-Type') || 'application/octet-stream',
      size:
        Number.isSafeInteger(length) && length >= 0 && response.headers.has('Content-Length')
          ? length
          : undefined,
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
  }): Promise<{ token: string; integration: Integration }> {
    return this.request('/integrations', input);
  }
  /** Human sessions only: revokes the token and removes the connection's destinations. */
  deleteIntegration(id: string): Promise<{ ok: true }> {
    return this.request('/integrations/' + path(id), undefined, { method: 'DELETE' });
  }
  /** `heartbeat: true` asks for a lease that lapses unless renewed with `heartbeatTask`. */
  claimTask(id: string, input: { runnerId: string; heartbeat?: boolean }): Promise<TaskClaim> {
    return this.request(`/tasks/${path(id)}/claim`, input);
  }
  heartbeatTask(id: string, lease: string): Promise<{ lease: string; leaseExpiresAt: string }> {
    return this.request(`/tasks/${path(id)}/heartbeat`, { lease });
  }
  /** Reports logs and/or the outcome; keyed log batches retry safely. */
  updateTask(
    id: string,
    update: TaskUpdate,
    options: Pick<RequestOptions, 'idempotencyKey' | 'retry'> = {},
  ): Promise<Message> {
    return this.request(`/tasks/${path(id)}/update`, update, options);
  }
  /** Consumes the encrypted envelopes of an answered request's secret fields. */
  collectSecrets(id: string): Promise<Record<string, Envelope>> {
    return this.request(`/messages/${path(id)}/secrets`, {});
  }
  /** `collectSecrets`, decrypted with the private key whose public key the request carried. */
  async revealSecrets(id: string, privateKey: JsonWebKey): Promise<Record<string, string>> {
    const envelopes = await this.collectSecrets(id);
    const values: Record<string, string> = {};
    for (const [field, envelope] of Object.entries(envelopes))
      values[field] = await unseal(envelope, privateKey);
    return values;
  }
  /** For a `kind: 'secret'` offer: the receiver's claim and public key once a device claims it. */
  secretReceiver(id: string, options: { signal?: AbortSignal } = {}): Promise<SecretReceiver> {
    return this.request(`/messages/${path(id)}/secret-receiver`, undefined, options);
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
        done = false,
        checking = false;
      const finish = (message?: Message, error?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        clearInterval(fallback);
        unsubscribe?.();
        options.signal?.removeEventListener('abort', abort);
        if (message) resolve(message);
        else reject(error);
      };
      const abort = () => finish(undefined, options.signal?.reason || new Error('Aborted.'));
      const check = async () => {
        if (done || checking) return;
        checking = true;
        try {
          const message = await this.get(id);
          if (['answered', 'expired', 'cancelled'].includes(message.status)) finish(message);
        } catch (e) {
          if (e instanceof HeraldError && e.status < 500 && e.status !== 429) finish(undefined, e);
        } finally {
          checking = false;
        }
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
      const fallback = setInterval(check, 30000);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      else {
        unsubscribe = this.live.subscribe(check);
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
      unsubscribe = this.live.subscribe(refresh);
      void refresh();
    }
    return stop;
  }
  /** Reserves and uploads a file; streams abort only after `idleTimeout` without progress. */
  async upload(
    name: string,
    data: UploadData,
    type = 'application/octet-stream',
    options: UploadOptions = {},
  ): Promise<Attachment> {
    const size =
      data instanceof Uint8Array
        ? data.byteLength
        : data instanceof Blob
          ? data.size
          : options.size;
    if (size === undefined || !Number.isSafeInteger(size) || size < 0)
      throw new Error('Pass the byte size for streamed uploads.');
    const file = await this.request<Attachment>('/files', { name, type, size });
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal!.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    const { body, done } = idleBody(data, (options.idleTimeout ?? 60) * 1000, controller);
    try {
      const response = await fetch(this.base + '/api/v1/files/' + path(file.id), {
        method: 'PUT',
        headers: this.#headers({ 'Content-Length': String(size) }),
        body,
        duplex: 'half',
        redirect: 'manual',
        signal: controller.signal,
      } as RequestInit);
      if (!response.ok) await readError(response, 'File upload failed.');
      await response.body?.cancel();
      return { id: file.id, name: file.name, size: file.size, type: file.type };
    } finally {
      done();
      options.signal?.removeEventListener('abort', abort);
    }
  }
}
export { verifyWebhook } from './webhook.js';
