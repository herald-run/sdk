import { describe, expect, it } from 'vitest';
import example from '../../fixtures/questions.json';
import {
  destinationSchema,
  fieldAnswers,
  fieldsSchema,
  isOption,
  messageInputSchema,
  matchesAction,
  optionSchema,
  questionAnswers,
  questionFields,
  questionsSchema,
  responseSchema,
  reviewImageTypes,
  validateAnswers,
  type Answers,
  type Field,
} from './index';
const action = { id: 'resume', label: 'Resume run', values: {} };
const attachment = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'preview.png',
  type: 'image/png',
  size: 10,
};
const image = { type: 'image', attachmentId: attachment.id, alt: 'Deployment preview' };
const valid = (input: Record<string, unknown>) =>
  messageInputSchema.safeParse({ title: 'Review', ...input }).success;
describe('request action contracts', () => {
  it('accepts simple actions, eight choices, custom labels and legacy approvals', () => {
    expect(valid({ actions: [action] })).toBe(true);
    expect(
      valid({ actions: Array.from({ length: 8 }, (_, i) => ({ ...action, id: 'choice_' + i })) }),
    ).toBe(true);
    expect(
      messageInputSchema.parse({
        title: 'Review',
        actions: [{ ...action, label: '<b>Resume</b>' }],
      }).actions?.[0].label,
    ).toBe('<b>Resume</b>');
    expect(
      valid({
        fields: [{ id: 'ok', label: 'Proceed?', type: 'boolean', required: true }],
        actions: [
          { id: 'approve', label: 'Approve', values: { ok: true } },
          { id: 'reject', label: 'Reject', values: { ok: false } },
        ],
      }),
    ).toBe(true);
  });
  it('rejects duplicate, excessive, executable and malformed actions', () => {
    for (const actions of [
      [],
      [action, action],
      Array.from({ length: 9 }, (_, i) => ({ ...action, id: 'a' + i })),
      [{ ...action, id: 'invalid/id' }],
      [{ ...action, id: 'a'.repeat(65) }],
      [{ ...action, label: '' }],
      [{ ...action, label: '   ' }],
      [{ ...action, label: 'a'.repeat(81) }],
      [{ ...action, command: '/bin/sh' }],
    ])
      expect(valid({ actions })).toBe(false);
    expect(responseSchema.safeParse({ values: {}, actionId: '../resume' }).success).toBe(false);
  });
  it('validates every prescribed answer and prohibits file or secret actions', () => {
    const fields = [
      {
        id: 'target',
        label: 'Target',
        type: 'select',
        required: true,
        options: [{ value: 'staging', label: 'Staging' }],
      },
    ];
    expect(valid({ fields, actions: [{ ...action, values: { target: 'staging' } }] })).toBe(true);
    for (const values of [{}, { target: 'production' }, { target: 'staging', injected: true }])
      expect(valid({ fields, actions: [{ ...action, values }] })).toBe(false);
    for (const type of ['file', 'secret'])
      expect(valid({ fields: [{ id: 'input', label: 'Input', type }], actions: [action] })).toBe(
        false,
      );
  });
  it('matches stored values exactly while ignoring object property order', () => {
    const actions = [{ ...action, values: { target: 'staging', tags: ['a', 'b'], ok: true } }];
    expect(
      matchesAction(actions, 'resume', { ok: true, tags: ['a', 'b'], target: 'staging' }),
    ).toBe(true);
    for (const values of [
      { target: 'production', tags: ['a', 'b'], ok: true },
      { target: 'staging', tags: ['b', 'a'], ok: true },
      { target: 'staging', ok: true },
      { target: 'staging', tags: ['a', 'b'], ok: true, extra: true },
    ] as Answers[])
      expect(matchesAction(actions, 'resume', values)).toBe(false);
    expect(matchesAction(actions, 'missing', actions[0].values)).toBe(false);
  });
});
describe('structured review contracts', () => {
  it('retains literal table cells and bounds row widths, counts and content', () => {
    const table = { type: 'table', columns: ['Change'], rows: [['<script>alert(1)</script>']] };
    expect(messageInputSchema.parse({ title: 'Review', blocks: [table] }).blocks?.[0]).toEqual(
      table,
    );
    for (const block of [
      { ...table, columns: [] },
      { ...table, columns: Array(13).fill('Header') },
      { ...table, rows: [['a', 'b']] },
      { ...table, rows: Array(101).fill(['cell']) },
      { ...table, rows: [['a'.repeat(2001)]] },
      { ...table, rows: Array(26).fill(['a'.repeat(2000)]) },
      { ...table, html: '<iframe src="https://external.test"></iframe>' },
    ])
      expect(valid({ blocks: [block] })).toBe(false);
    expect(valid({ blocks: Array(11).fill(table) })).toBe(false);
    expect(valid({ blocks: [{ type: 'html', text: '<script>run()</script>' }] })).toBe(false);
    expect(valid({ blocks: [{ type: 'json', text: '{invalid' }] })).toBe(false);
  });
  it('requires an attached safe raster file and rejects SVG or external image sources', () => {
    for (const type of reviewImageTypes)
      expect(valid({ attachments: [{ ...attachment, type }], blocks: [image] })).toBe(true);
    expect(valid({ blocks: [image] })).toBe(false);
    for (const type of [
      'image/svg+xml',
      'text/html',
      'application/octet-stream',
      'image/png; charset=utf-8',
    ])
      expect(valid({ attachments: [{ ...attachment, type }], blocks: [image] })).toBe(false);
    for (const block of [
      { ...image, attachmentId: 'https://external.test/image.png' },
      { ...image, attachmentId: '00000000-0000-4000-8000-000000000002' },
      { ...image, src: 'https://external.test/image.png' },
      { ...image, alt: 'a'.repeat(501) },
    ])
      expect(valid({ attachments: [attachment], blocks: [block] })).toBe(false);
  });
});
describe('questions and Other answers', () => {
  const fields = example.fields as Field[];
  it('converts agent questions into required choice fields and answers', () => {
    const questions = questionsSchema.parse(example.questions);
    expect(questionFields(questions)).toEqual(fields);
    expect(validateAnswers(fields, example.values as Answers)).toEqual({});
    expect(questionAnswers(questions, example.values as Answers)).toEqual(example.answers);
    expect(fieldAnswers(fields, example.values as Answers)).toEqual(example.answers);
    for (const other of [fields.slice(1), [{ ...fields[0], other: false }]])
      expect(fieldAnswers(other, example.values as Answers)).toBeUndefined();
    for (const values of example.rejected as Answers[])
      expect(Object.keys(validateAnswers(fields, values)).length).toBe(1);
    const long = questionFields(
      questionsSchema.parse([{ question: 'a'.repeat(200), options: [{ label: 'x' }] }]),
    )[0];
    expect([long.label.length, long.help, long.type]).toEqual([120, 'a'.repeat(200), 'select']);
    for (const bad of [
      [],
      [{ question: 'Q', options: [] }],
      [{ question: ' ', options: [{ label: 'x' }] }],
      [{ question: 'Q', options: [{ label: 'x' }, { label: 'x' }] }],
      ...example.invalid,
      [{ question: 'Q', header: 'h'.repeat(25), options: [{ label: 'x' }] }],
    ])
      expect(questionsSchema.safeParse(bad).success).toBe(false);
  });
  it('validates Other text and the new field keys', () => {
    const [select, multi] = fields;
    expect(validateAnswers([select], { q1: '' })).toEqual({ q1: 'Enter your answer.' });
    expect(validateAnswers([{ ...select, other: false }], { q1: 'MySQL' })).toEqual({
      q1: 'Choose an available option.',
    });
    expect(validateAnswers([multi], { q2: ['a', 'b'] })).toEqual({
      q2: 'Choose from the available options.',
    });
    expect(validateAnswers([multi], { q2: ['Lint', ''] })).toEqual({ q2: 'Enter your answer.' });
    expect(isOption(select, 'SQLite') && !isOption(select, 'MySQL')).toBe(true);
    const field = { id: 'a', label: 'A', type: 'text' };
    expect(
      validateAnswers([{ ...field, maxLength: 2 } as Field], { a: '\u{1F600}\u{1F600}' }),
    ).toEqual({});
    expect(fieldsSchema.safeParse([{ ...field, header: 'Short' }]).success).toBe(true);
    for (const bad of [{ other: true }, { header: '' }, { header: 'h'.repeat(25) }])
      expect(fieldsSchema.safeParse([{ ...field, ...bad }]).success).toBe(false);
    const option = { value: 'x', label: 'X' };
    for (const extra of [{ description: 'd'.repeat(301) }, { preview: 'p'.repeat(4001) }])
      expect(optionSchema.safeParse({ ...option, ...extra }).success).toBe(false);
  });
  it('accepts questions as message input instead of fields or schema', () => {
    const parsed = messageInputSchema.parse({ title: 'Q', questions: example.questions });
    expect(parsed.kind !== 'secret' && parsed.fields).toEqual(fields);
    for (const extra of [
      { fields: [{ id: 'a', label: 'A', type: 'text' }] },
      { schema: { type: 'object', properties: {} } },
      { kind: 'secret' },
    ])
      expect(valid({ questions: example.questions, ...extra })).toBe(false);
    const values = { q1: 'Postgres', q2: ['Lint'], q3: 'Any' };
    expect(valid({ questions: example.questions, actions: [{ ...action, values }] })).toBe(true);
  });
});
describe('PDF annotations', () => {
  const pdf = { ...attachment, name: 'plan.pdf', type: 'application/pdf' };
  const field = { id: 'comments', label: 'Comments', type: 'annotations', attachmentId: pdf.id };
  const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  const note = { page: 4, anchor: 'page' as const, text: 'Check this' };
  const text = { ...note, anchor: 'text' as const, quote: 'Open', boxes: [box, box] };
  const image = { ...note, anchor: 'image' as const, boxes: [box] };
  const fields = fieldsSchema.parse([field]);
  it('keeps annotations fields out of destination types', () => {
    const types = [{ id: 'review', label: 'Review', fields: [field] }];
    expect(destinationSchema.safeParse({ key: 'pdf', types }).success).toBe(false);
  });
  it('needs an annotations field to name an attached PDF', () => {
    expect(valid({ kind: 'form', attachments: [pdf], fields: [field] })).toBe(true);
    expect(valid({ kind: 'form', fields: [field] })).toBe(false);
    expect(valid({ kind: 'form', attachments: [attachment], fields: [field] })).toBe(false);
    expect(
      valid({
        kind: 'form',
        attachments: [pdf],
        fields: [{ ...field, attachmentId: '00000000-0000-4000-8000-000000000002' }],
      }),
    ).toBe(false);
  });
  it('allows attachmentId only on annotations fields, which cannot have defaults', () => {
    const { attachmentId, ...bare } = field;
    for (const bad of [bare, { ...field, default: [] }, { ...field, attachmentId: 'nope' }])
      expect(fieldsSchema.safeParse([bad]).success).toBe(false);
    for (const type of ['text', 'file'])
      expect(fieldsSchema.safeParse([{ ...field, type }]).success).toBe(false);
    expect(attachmentId).toBe(pdf.id);
  });
  it('validates annotation answers', () => {
    const good: Answers[] = [{}, { comments: [] }, { comments: [note, text, image] }];
    for (const values of good) expect(validateAnswers(fields, values)).toEqual({});
    for (const bad of [
      { ...note, page: 0 },
      { ...note, page: 1.5 },
      { ...note, anchor: 'line' },
      { ...text, quote: undefined },
      { ...text, quote: ' ' },
      { ...note, boxes: [box] },
      { ...image, boxes: [box, box] },
      { ...image, quote: 'Open' },
      { ...image, boxes: [{ ...box, x: 1.1 }] },
      { ...image, boxes: [{ ...box, y: -0.1 }] },
      { ...text, boxes: Array(101).fill(box) },
      { ...text, boxes: [] },
      { ...image, boxes: [{ x: 0.1, y: 0.2, w: 0.3 }] },
      { ...note, text: '  ' },
      { ...note, extra: 1 },
      'text',
      { page: 1 },
    ])
      expect(Object.keys(validateAnswers(fields, { comments: [bad] as never }))).toEqual([
        'comments',
      ]);
    for (const bad of ['text', 5, true, { page: 1 }])
      expect(Object.keys(validateAnswers(fields, { comments: bad as never }))).toEqual([
        'comments',
      ]);
    expect(Object.keys(validateAnswers(fields, { comments: Array(501).fill(note) }))).toEqual([
      'comments',
    ]);
  });
  it('requires a comment when the field is required and keeps other fields strict', () => {
    const required = fieldsSchema.parse([{ ...field, required: true }]);
    expect(Object.keys(validateAnswers(required, { comments: [] }))).toEqual(['comments']);
    expect(Object.keys(validateAnswers(required, {}))).toEqual(['comments']);
    expect(validateAnswers(required, { comments: [note] })).toEqual({});
    const multi = fieldsSchema.parse([
      { id: 'm', label: 'M', type: 'multiselect', options: [{ value: 'a', label: 'A' }] },
    ]);
    expect(validateAnswers(multi, { m: ['a'] })).toEqual({});
    expect(Object.keys(validateAnswers(multi, { m: [note] as never }))).toEqual(['m']);
    const text = fieldsSchema.parse([{ id: 't', label: 'T', type: 'text' }]);
    expect(Object.keys(validateAnswers(text, { t: [note] as never }))).toEqual(['t']);
  });
  it('lets an action answer a form whose annotations are optional', () => {
    const base = { kind: 'form', attachments: [pdf], actions: [action] };
    expect(valid({ ...base, fields: [field] })).toBe(true);
    expect(valid({ ...base, fields: [{ ...field, required: true }] })).toBe(false);
  });
});
