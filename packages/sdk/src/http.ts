export class HeraldError extends Error {
  constructor(
    message: string,
    public status: number,
    public messageId?: string,
    /** Seconds from the server's Retry-After header, when sent. */
    public retryAfter?: number,
    /** Machine-readable code from the server's error body, e.g. `RATE_LIMITED`. */
    public code?: string,
  ) {
    super(message);
    this.name = 'HeraldError';
  }
}
/** Retry-After as seconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = /^\d+$/.test(value.trim())
    ? Number(value)
    : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : undefined;
}
/** Network and 5xx retry delay: 250 ms doubling, with 50–100% jitter. */
export const retryDelay = (attempt: number) => 250 * 2 ** attempt * (0.5 + Math.random() / 2);
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
type ErrorBody = {
  error?: string | { message?: string; code?: string };
  message?: string;
  code?: string;
};
const errorText = (data: unknown) => {
  const body = data as ErrorBody | undefined;
  return typeof body?.error === 'string' ? body.error : body?.error?.message || body?.message;
};
const errorCode = (data: unknown) => {
  const body = data as ErrorBody | undefined;
  const code = typeof body?.error === 'object' ? body.error?.code : body?.code;
  return typeof code === 'string' ? code : undefined;
};
/** Checks status and content type before parsing, so proxies' HTML pages never reach JSON.parse. */
/** Rejects a failed response with its error body's message and code. */
export async function readError(response: Response, fallback: string): Promise<never> {
  const json = /^application\/([\w.-]+\+)?json\b/i.test(response.headers.get('Content-Type') || '');
  const data: unknown = json
    ? await response.json().catch(() => undefined)
    : await response.body?.cancel();
  throw new HeraldError(
    errorText(data) || fallback,
    response.status,
    undefined,
    parseRetryAfter(response.headers.get('Retry-After')),
    errorCode(data),
  );
}
export async function readJson<T>(response: Response, retryAfter?: number): Promise<T> {
  const json = /^application\/([\w.-]+\+)?json\b/i.test(response.headers.get('Content-Type') || '');
  const data: unknown = json
    ? await response.json().catch(() => undefined)
    : await response.body?.cancel();
  if (!response.ok)
    throw new HeraldError(
      errorText(data) || `Herald request failed (${response.status}).`,
      response.status,
      undefined,
      retryAfter,
      errorCode(data),
    );
  if (response.status === 204) return undefined as T;
  if (!json || data === undefined)
    throw new HeraldError('Herald returned a response that is not JSON.', response.status);
  return data as T;
}
