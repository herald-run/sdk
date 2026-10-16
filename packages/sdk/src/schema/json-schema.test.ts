import { describe, it, expect } from 'vitest';
import {
  fieldsSchema,
  jsonSchemaFields,
  messageInputSchema,
  validateAnswers,
  defaultAnswers,
} from './index';
describe('JSON Schema form contract', () => {
  it('renders typed defaults and rejects answers outside constraints', () => {
    const fields = jsonSchemaFields({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['approve', 'reject'] },
        backup: { type: 'boolean', default: true },
        count: { type: 'integer', minimum: 1, maximum: 3 },
        notes: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
      },
      required: ['action'],
    });
    expect(defaultAnswers(fields)).toEqual({ backup: true, notes: null });
    expect(
      validateAnswers(fields, { action: 'approve', backup: true, count: 2, notes: null }),
    ).toEqual({});
    expect(validateAnswers(fields, { action: 'other', count: 1.5, backup: null })).toMatchObject({
      action: expect.any(String),
      count: expect.any(String),
      backup: expect.any(String),
    });
  });
  it('rejects unsupported schemas and invalid defaults rather than silently weakening validation', () => {
    for (const property of [
      { type: 'object', properties: {} },
      { type: 'string', pattern: '.*' },
      { $ref: 'https://remote.test/schema' },
      { type: 'string', enum: ['yes'], default: 'no' },
      { type: 'number', format: 'uuid' },
    ])
      expect(() => jsonSchemaFields({ type: 'object', properties: { value: property } })).toThrow();
    expect(() =>
      jsonSchemaFields({ type: 'object', properties: {}, required: ['missing'] }),
    ).toThrow();
    expect(
      messageInputSchema.safeParse({
        title: 'Both',
        fields: [{ id: 'a', type: 'text', label: 'A' }],
        schema: { type: 'object', properties: {} },
      }).success,
    ).toBe(false);
  });
  it('requires complete prescribed actions and protects secret defaults', () => {
    const base = {
      title: 'Proceed',
      fields: [{ id: 'approved', type: 'boolean', label: 'Proceed?', required: true }],
      actions: [
        { id: 'approve', label: 'Approve', values: { approved: true } },
        { id: 'reject', label: 'Reject', values: { approved: false } },
      ],
    };
    expect(messageInputSchema.safeParse(base).success).toBe(true);
    expect(
      messageInputSchema.safeParse({
        ...base,
        actions: [...base.actions.slice(0, 1), { id: 'reject', label: 'Approve', values: {} }],
      }).success,
    ).toBe(false);
    expect(() =>
      jsonSchemaFields({
        type: 'object',
        properties: { key: { type: 'string', 'x-herald-type': 'secret', default: 'secret' } },
      }),
    ).toThrow();
  });
});
it('copies array defaults without cloning framework proxies', () => {
  const choices = new Proxy(['one'], {});
  const values = defaultAnswers([
    {
      id: 'choices',
      label: 'Choices',
      type: 'multiselect',
      required: false,
      default: choices,
      options: [{ value: 'one', label: 'One' }],
    },
  ]);
  expect(values.choices).toEqual(['one']);
  expect(values.choices).not.toBe(choices);
});

it('enforces optional constraints on supplied empty values and rejects invalid dates', () => {
  const fields = jsonSchemaFields({
    type: 'object',
    properties: {
      note: { type: 'string', minLength: 2 },
      tags: { type: 'array', items: { type: 'string', enum: ['one'] }, minItems: 1 },
      day: { type: 'string', format: 'date' },
    },
  });
  expect(validateAnswers(fields, {})).toEqual({});
  expect(validateAnswers(fields, { note: '', tags: [], day: '2026-02-30' })).toMatchObject({
    note: expect.any(String),
    tags: expect.any(String),
    day: expect.any(String),
  });
  expect(validateAnswers(fields, { day: '2028-02-29' })).toEqual({});
});

it('accepts Pydantic enums as local $defs references and exclusive bounds', () => {
  // `Deploy.model_json_schema()` from Pydantic 2 with an `Env` str enum and `gt`/`lt` bounds.
  const env = { $ref: '#/$defs/Env' };
  const fields = jsonSchemaFields({
    $defs: {
      Env: {
        description: 'Where to deploy.',
        enum: ['staging', 'production'],
        title: 'Env',
        type: 'string',
      },
    },
    properties: {
      env,
      fallback: { anyOf: [env, { type: 'null' }], default: null },
      regions: { default: [], items: env, title: 'Regions', type: 'array', uniqueItems: true },
      replicas: { exclusiveMaximum: 10, exclusiveMinimum: 0, title: 'Replicas', type: 'integer' },
      target: { ...env, default: 'staging' },
    },
    required: ['env', 'replicas'],
    title: 'Deploy',
    type: 'object',
  });
  const choices = [
    { value: 'staging', label: 'staging' },
    { value: 'production', label: 'production' },
  ];
  expect(fields.map((f) => [f.id, f.label, f.type, f.nullable])).toEqual([
    ['env', 'env', 'select', false],
    ['fallback', 'fallback', 'select', true],
    ['regions', 'Regions', 'multiselect', false],
    ['replicas', 'Replicas', 'number', false],
    ['target', 'target', 'select', false],
  ]);
  expect(fields.map((f) => f.options).filter(Boolean)).toEqual([
    choices,
    choices,
    choices,
    choices,
  ]);
  expect(validateAnswers(fields, { env: 'staging', replicas: 9, target: 'staging' })).toEqual({});
  for (const replicas of [0, 10])
    expect(validateAnswers(fields, { env: 'staging', replicas })).toHaveProperty('replicas');
  for (const $ref of ['#/$defs/Missing', 'https://remote.test/schema#/$defs/Env'])
    expect(() =>
      jsonSchemaFields({ type: 'object', $defs: { Env: {} }, properties: { env: { $ref } } }),
    ).toThrow('Only local $defs references');
});
it('rejects exclusive bounds that leave no value', () => {
  const number = (bounds: object) =>
    fieldsSchema.safeParse([{ id: 'n', label: 'N', type: 'number', ...bounds }]).success;
  expect(number({ exclusiveMinimum: 0, exclusiveMaximum: 1 })).toBe(true);
  expect(number({ minimum: 1, exclusiveMaximum: 1 })).toBe(false);
  expect(number({ exclusiveMinimum: 1, maximum: 1 })).toBe(false);
  expect(number({ exclusiveMinimum: 2, exclusiveMaximum: 1 })).toBe(false);
  expect(() =>
    jsonSchemaFields({
      type: 'object',
      properties: { n: { type: 'number', exclusiveMinimum: 5, exclusiveMaximum: 5 } },
    }),
  ).toThrow('Minimum constraints');
});
it('marks secret file fields, answered through secrets only', () => {
  const file = { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 1 };
  const [field] = jsonSchemaFields({
    type: 'object',
    properties: { cert: { ...file, 'x-herald-type': 'secret-file' } },
    required: ['cert'],
  });
  expect(field).toMatchObject({ type: 'file', secret: true, required: true, maxItems: 1 });
  expect(validateAnswers([field], {}, ['cert'])).toEqual({});
  expect(validateAnswers([field], {})).toHaveProperty('cert');
  const secretText = { id: 'key', label: 'Key', type: 'text', secret: true };
  expect(fieldsSchema.safeParse([secretText]).success).toBe(false);
  expect(fieldsSchema.safeParse([{ ...field, default: [] }]).success).toBe(false);
});
