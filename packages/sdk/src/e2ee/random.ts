import type { Bytes } from './bytes';
let source: ((length: number) => Bytes) | undefined;
let clock: (() => string) | undefined;
/** Replaces randomness and time. Only for reproducible test vectors; not exported by the package. */
export function setTestHooks(hooks?: { random?: (length: number) => Bytes; now?: () => string }) {
  source = hooks?.random;
  clock = hooks?.now;
}
export const randomBytes = (length: number): Bytes =>
  source ? source(length) : crypto.getRandomValues(new Uint8Array(length));
export const now = () => (clock ? clock() : new Date().toISOString());
