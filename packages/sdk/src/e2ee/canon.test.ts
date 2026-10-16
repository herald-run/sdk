import { expect, it } from 'vitest';
import { b64u, E2eeError } from './bytes';
import { canon } from './canon';
import { H } from './hash';
it('sorts keys by UTF-16 code unit and writes compact JSON', () => {
  const value = {
    '': 1,
    '\u{1f600}': 2,
    a: [true, null, 'x'],
    Z: { b: 1, a: -0 },
    é: 'é',
    skip: undefined,
  };
  expect(canon(value)).toBe('{"Z":{"a":0,"b":1},"a":[true,null,"x"],"é":"é","\u{1f600}":2,"":1}');
  expect(canon('\u0001\n"\\ \ud800')).toBe('"\\u0001\\n\\"\\\\ \\ud800"');
  expect(canon([0.5, 1e-7, -1.25e-10, 123456.789, 9007199254740991])).toBe(
    '[0.5,1e-7,-1.25e-10,123456.789,9007199254740991]',
  );
  expect(canon(Object.create(null))).toBe('{}');
});
it('rejects values without one canonical form', () => {
  for (const bad of [
    NaN,
    Infinity,
    2 ** 53,
    1e21,
    undefined,
    [undefined],
    () => 1,
    new Date(0),
    1n,
    new Uint8Array(1),
  ])
    expect(() => canon(bad), String(bad)).toThrow(E2eeError);
});
it('encodes base64url strictly', () => {
  expect(b64u.encode(Uint8Array.of(251, 255))).toBe('-_8');
  expect(b64u.decode('-_8')).toEqual(Uint8Array.of(251, 255));
  expect(b64u.decode('')).toEqual(new Uint8Array(0));
  for (const bad of ['-_9', '+/8', 'AA==', 'A', 'AA A'])
    expect(() => b64u.decode(bad), bad).toThrow(E2eeError);
});
it('domain-separates hashes by label', async () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const { createHash } = await import('node:crypto');
  const want = createHash('sha256').update('herald/e2ee/v1 file\0').digest('hex');
  expect(hex(await H('file'))).toBe(want);
  expect(hex(await H('wrap', 'prf', Uint8Array.of(1)))).toBe(
    createHash('sha256').update('herald/e2ee/v1 wrap\0prf\x01').digest('hex'),
  );
});
