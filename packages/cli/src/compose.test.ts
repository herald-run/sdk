import { expect, it } from 'vitest';
import { actionSpec, fieldSpec, outputs, parseCsv, titleCase } from './compose';

it('parses CSV with quotes, doubled quotes, CRLF and embedded newlines', () => {
  expect(parseCsv('a,"b, c"\r\n"say ""hi""","two\nlines"\n\n')).toEqual([
    ['a', 'b, c'],
    ['say "hi"', 'two\nlines'],
  ]);
  expect(parseCsv('x\ny')).toEqual([['x'], ['y']]);
  expect(() => parseCsv('"open')).toThrow('unterminated');
});
it('parses field and action specs', () => {
  expect(titleCase('api_key')).toBe('Api Key');
  expect(titleCase('githubToken')).toBe('Github Token');
  expect(fieldSpec('token:secret:GitHub token')).toMatchObject({
    id: 'token',
    type: 'secret',
    label: 'GitHub token',
    required: true,
    maxLength: 16000,
  });
  expect(fieldSpec('kube?:secret-file')).toMatchObject({
    id: 'kube',
    type: 'file',
    secret: true,
    maxItems: 1,
    label: 'Kube',
    required: false,
  });
  expect(fieldSpec('env:multiselect:Env:a, b=Bee').options).toEqual([
    { value: 'a', label: 'a' },
    { value: 'b', label: 'Bee' },
  ]);
  for (const bad of ['x', 'x:bogus', 'x:select', 'x:text:X:a', '1x:text'])
    expect(() => fieldSpec(bad)).toThrow(`--field ${bad}:`);
  expect(actionSpec('ship:Ship it')).toEqual({ id: 'ship', label: 'Ship it', values: {} });
  expect(actionSpec('skip_it').label).toBe('Skip It');
});
it('maps --out to secret and file fields', () => {
  const one = [fieldSpec('note:text'), fieldSpec('token:secret')];
  expect(outputs(['/tmp/t'], one, true)).toEqual([{ field: 'token', path: '/tmp/t' }]);
  const two = [...one, fieldSpec('logs?:file')];
  expect(() => outputs(['/tmp/t'], two, false)).toThrow('exactly one');
  expect(() => outputs(['note=/tmp/n'], two, false)).toThrow('no secret or file field');
  expect(() => outputs(['logs=/tmp/l'], two, true)).toThrow('Secret fields need --out: token');
  expect(() => outputs(['token=/a', 'token=/b'], two, true)).toThrow('one --out');
  expect(outputs(['logs=/tmp/l', 'token=/tmp/t'], two, true)).toHaveLength(2);
});
