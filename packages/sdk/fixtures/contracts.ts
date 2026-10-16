/**
 * Contract fixtures: one scenario the server replays and both SDKs reproduce.
 * Responses use `<id>`, `<time>`, `<string>` and `<number>` for generated values; requests use
 * `{step.path}` for an earlier step's result, or `{values.name}` for shared literals. Python mirrors
 * this in `packages/python/tests/test_contracts.py`.
 */
import contracts from './contracts.json';
export type Exchange = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
};
export type Reply = { status: number; body: unknown };
export type Step = {
  name: string;
  /** Runs as the signed-in owner; otherwise as the "Runner" integration with every scope. */
  principal?: 'owner';
  /** Server-only setup (an owner's web action); the SDKs skip it. */
  setup?: boolean;
  request: Exchange;
  response: Reply;
  /** `upload` only: the PUT of the reserved file's bytes. */
  upload?: { path: string; text: string; response: Reply };
};
export const steps = contracts.steps as Step[];
/**
 * A keyed integration's step (`e2ee.steps`), replayed by the SDKs with concrete values. Sealed
 * request parts are random, so `sealed` names each one by dotted path with the payload it carries.
 */
export type SealedStep = Omit<Step, 'upload'> & {
  /** The SDK call's input, when it is not the request body. */
  input?: unknown;
  sealed?: Record<string, unknown>;
  /** `upload` only: the PUT of the encrypted bytes of `plain`. */
  upload?: { path: string; plain: string; response: Reply };
  /** The response body is base64url file bytes. */
  bytes?: boolean;
  /** What the SDK returns; `<string>` matches any string. */
  result?: unknown;
  /** The SDK rejects with this message instead. */
  error?: string;
};
export type SealedContracts = {
  token: string;
  keyring: import('../src/e2ee/index').Keyring;
  steps: SealedStep[];
};
export const sealedContracts = (contracts as { e2ee?: SealedContracts }).e2ee!;
type Results = Record<string, unknown>;
/** Results before the first step: only the shared literals. */
export const initialResults = (): Results => ({ values: contracts.values });
const lookup = (results: Results, ref: string) =>
  ref
    .split('.')
    .reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], results);
/** Replaces `{step.path}` references with values from earlier results. */
export function substitute<T>(value: T, results: Results): T {
  if (typeof value === 'string') {
    const whole = /^\{([\w.-]+)\}$/.exec(value);
    if (whole) return lookup(results, whole[1]) as T;
    return value.replace(/\{([\w.-]+)\}/g, (_, ref) => String(lookup(results, ref))) as T;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, results)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v, results)]),
    ) as T;
  return value;
}
const samples: Record<string, (step: string) => unknown> = {
  '<id>': (step) => step + '-id',
  '<time>': () => '2030-01-01T00:00:00.000Z',
  '<string>': () => 'string',
  '<number>': () => 1,
};
/** A concrete response for SDK tests: each placeholder becomes a fixed sample value. */
export function materialize(value: unknown, step: string): unknown {
  if (typeof value === 'string' && samples[value]) return samples[value](step);
  if (Array.isArray(value)) return value.map((v) => materialize(v, step));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, materialize(v, step)]));
  return value;
}
