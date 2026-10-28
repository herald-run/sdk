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
it('adds a comments field for --annotate and uploads a shared PDF once', async () => {
  const stdin = async () => '';
  const draft = await composeMessage(
    { annotate: ['/tmp/plan.pdf'], file: ['/tmp/plan.pdf'], action: ['ok'] },
    undefined,
    true,
    stdin,
  );
  const [pdf, ...rest] = draft.input.attachments!;
  expect(rest).toEqual([]);
  expect(pdf).toMatchObject({ name: 'plan.pdf', type: 'application/pdf' });
  expect(draft.input).toMatchObject({ kind: 'form' });
  expect(draft.input.fields).toEqual([
    {
      id: 'comments',
      type: 'annotations',
      label: 'Comments',
      required: false,
      attachmentId: pdf.id,
    },
  ]);
  // No reply field is added next to the comments.
  const wait = await composeMessage({ annotate: ['/tmp/plan.pdf'] }, undefined, true, stdin);
  expect(wait.fields.map((f) => f.id)).toEqual(['comments']);
  const more = await composeMessage(
    { annotate: ['/tmp/plan.pdf'], field: ['note?:text'] },
    undefined,
    false,
    stdin,
  );
  expect(more.fields.map((f) => f.id)).toEqual(['note', 'comments']);
});
it('refuses --annotate with a non-PDF or more than once', async () => {
  const stdin = async () => '';
  for (const annotate of [['/tmp/a.png'], ['/tmp/a'], ['/tmp/a.pdf', '/tmp/b.pdf']])
    await expect(composeMessage({ annotate }, undefined, false, stdin)).rejects.toThrow(/PDF|once/);
});
it('lets -i name a local PDF for an annotations field, relative to the input file', async () => {
  const stdin = async () => '';
  const base = {
    title: 'Review',
    fields: [{ id: 'notes', label: 'Notes', type: 'annotations', file: 'docs/plan.pdf' }],
  };
  const draft = await composeMessage({ input: '/work/in.json' }, base, false, stdin);
  const [pdf] = draft.input.attachments!;
  expect(pdf).toMatchObject({ name: 'plan.pdf', type: 'application/pdf' });
  expect(draft.input.fields).toEqual([
    { id: 'notes', label: 'Notes', type: 'annotations', attachmentId: pdf.id },
  ]);
  const bad = { fields: [{ ...base.fields[0], file: 'plan.txt' }] };
  await expect(composeMessage({}, bad, false, stdin)).rejects.toThrow('use a PDF file');
  // A field naming an attachment needs no file.
  const named = {
    title: 'T',
    fields: [{ id: 'n', label: 'N', type: 'annotations', attachmentId: pdf.id }],
  };
  await expect(composeMessage({}, named, false, stdin)).rejects.toThrow('attached PDF');
});
