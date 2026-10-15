import { describe, expect, it } from 'vitest';
import {
  messageInputSchema,
  matchesAction,
  responseSchema,
  reviewImageTypes,
  type Answers,
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
