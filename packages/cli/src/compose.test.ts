import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { actionSpec, composeMessage, fieldSpec, outputs, parseCsv, titleCase } from './compose';

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
it('refuses flag actions with a required field', async () => {
  const stdin = async () => '';
  const flags = { field: ['env:select:Env:a,b'], action: ['ship'] };
  await expect(composeMessage(flags, undefined, true, stdin)).rejects.toThrow(
    'every field optional',
  );
  const ok = await composeMessage(
    { ...flags, field: ['env?:select:Env:a,b'] },
    undefined,
    true,
    stdin,
  );
  expect(ok.input.actions).toHaveLength(1);
});
it('composes questions input without a reply field or flag actions', async () => {
  const stdin = async () => '';
  const path = new URL('../../../examples/questions.json', import.meta.url);
  const base = JSON.parse(await readFile(path, 'utf8'));
  const draft = await composeMessage({}, base, true, stdin);
  expect(draft.input.kind).toBe('form');
  expect(draft.input.fields).toBeUndefined();
  expect(draft.fields.map((f) => [f.id, f.type, f.other])).toEqual([
    ['q1', 'select', true],
    ['q2', 'select', true],
    ['q3', 'multiselect', true],
  ]);
  await expect(composeMessage({ action: ['ship'] }, base, true, stdin)).rejects.toThrow(
    'no questions',
  );
  await expect(composeMessage({ field: ['x:text'] }, base, true, stdin)).rejects.toThrow(
    'not several',
  );
});
