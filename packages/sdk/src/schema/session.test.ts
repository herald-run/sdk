import { describe, expect, it } from 'vitest';
import {
  defaultAnswers,
  destinationSchema,
  requestTypeFields,
  sessionInputSchema,
  sessionRequest,
  sessionValues,
  taskPayload,
  validateRequestValues,
} from './index';
import example from '../../fixtures/session-destination.json';

describe('registered session requests', () => {
  const type = destinationSchema.parse(example).types[0];
  it('supports prompt-only registrations and validates prompts on the same contract', () => {
    const simple = destinationSchema.parse({
      name: 'Any harness',
      types: [{ id: 'new', label: 'New Session', kind: 'session' }],
    }).types[0];
    expect(requestTypeFields(simple).map((field) => field.id)).toEqual(['prompt']);
    expect(validateRequestValues(simple, { prompt: '   ' })).toHaveProperty('prompt');
    expect(
      validateRequestValues(simple, { prompt: 'Investigate a bug', model: 'unregistered' }),
    ).toHaveProperty('model');
    expect(validateRequestValues(simple, { prompt: 'Investigate a bug' })).toEqual({});
  });
  it('delivers declared mode, model, effort and selected command arguments without shell interpolation', () => {
    const values = {
      ...defaultAnswers(requestTypeFields(type)),
      prompt: 'Review the changes',
      model: 'balanced',
      effort: 'high',
      command: 'review',
      argument_base: 'main; echo untrusted',
      argument_focus: ['tests'],
      workspace: 'repo-a',
    };
    expect(validateRequestValues(type, values)).toEqual({});
    expect(sessionRequest(type, values)).toEqual({
      prompt: 'Review the changes',
      modes: { permission: 'ask' },
      model: 'balanced',
      effort: 'high',
      command: { id: 'review', arguments: { base: 'main; echo untrusted', focus: ['tests'] } },
    });
    expect(validateRequestValues(type, { ...values, command: 'investigate' })).toHaveProperty(
      'argument_base',
    );
    expect(
      validateRequestValues(type, { ...values, mode_permission: 'unregistered' }),
    ).toHaveProperty('mode_permission');
    expect(validateRequestValues(type, { ...values, command: 'unknown' })).toHaveProperty(
      'command',
    );
  });
  it('rejects conflicting registrations, invalid defaults and out-of-bounds attachments', () => {
    const wrap = (session: unknown, fields: unknown[] = []) => ({
      name: 'Runner',
      types: [{ id: 'new', label: 'New', kind: 'session', session, fields }],
    });
    expect(
      destinationSchema.safeParse(wrap({}, [{ id: 'prompt', label: 'Override', type: 'text' }]))
        .success,
    ).toBe(false);
    expect(
      destinationSchema.safeParse(
        wrap({ model: { label: 'Model', default: 'x', options: [{ value: 'y', label: 'Y' }] } }),
      ).success,
    ).toBe(false);
    expect(
      destinationSchema.safeParse(
        wrap({
          commands: [
            {
              id: 'secret',
              label: 'Secret',
              arguments: [{ id: 'token', label: 'Token', type: 'secret' }],
            },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      validateRequestValues(type, {
        prompt: 'Hello',
        attachments: Array.from({ length: 6 }, () => crypto.randomUUID()),
      }),
    ).toHaveProperty('attachments');
    expect(
      validateRequestValues(type, { prompt: 'Hello', attachments: ['file:///private/token'] }),
    ).toHaveProperty('attachments');
  });
  it('round-trips form values through the typed outbox payload', () => {
    const file = crypto.randomUUID();
    const values = {
      prompt: 'Review',
      attachments: [file],
      mode_permission: 'ask',
      model: 'fast',
      command: 'review',
      argument_base: 'main',
      workspace: 'repo-a',
    };
    const payload = taskPayload(type, values);
    expect(payload).toEqual({
      values: { workspace: 'repo-a' },
      session: {
        prompt: 'Review',
        modes: { permission: 'ask' },
        model: 'fast',
        command: { id: 'review', arguments: { base: 'main' } },
        attachments: [file],
      },
    });
    const session = sessionInputSchema.parse(payload.session);
    expect({ ...payload.values, ...sessionValues(session) }).toEqual(values);
    expect(taskPayload({ ...type, kind: undefined }, values)).toEqual({ values });
  });
});
