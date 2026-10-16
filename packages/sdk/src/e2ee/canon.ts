import { fail } from './bytes';
/**
 * Canonical JSON for signed and hashed structures: keys sorted by UTF-16 code unit, no
 * whitespace, numbers and strings as JSON.stringify writes them, integers within the safe range.
 */
export function canon(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      fail('canon: number out of range.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) fail('canon: unsupported object.');
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      '{' + entries.map(([key, item]) => JSON.stringify(key) + ':' + canon(item)).join(',') + '}'
    );
  }
  return fail(`canon: unsupported ${typeof value}.`);
}
