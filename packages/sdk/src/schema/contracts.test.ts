import { describe, expect, it } from 'vitest';
import { fieldsSchema, messageInputSchema, validateAnswers, type Field } from './index';
import { createKeys, seal, unseal } from './crypto';
describe('form boundaries', () => {
  const choice: Field = {
    id: 'environment',
    label: 'Environment',
    type: 'select',
    required: true,
    options: [{ value: 'staging', label: 'Staging' }],
  };
  it('rejects undeclared fields and forged choice values', () => {
    expect(
      validateAnswers([choice], { environment: 'production', injected: 'yes' }),
    ).toHaveProperty('environment');
    expect(validateAnswers([choice], { injected: 'yes' })).toHaveProperty('injected');
    expect(validateAnswers([choice], { environment: 'staging' })).toEqual({});
  });
  it('rejects duplicate fields and takes secret fields without a requester key', () => {
    expect(fieldsSchema.safeParse([choice, choice]).success).toBe(false);
    expect(
      messageInputSchema.safeParse({
        title: 'Key',
        fields: [{ id: 'key', label: 'Key', type: 'secret' }],
      }).success,
    ).toBe(true);
  });
  it('encrypts long secrets for only the requesting key', async () => {
    const a = await createKeys();
    const b = await createKeys();
    const text = 'a secret credential '.repeat(1000);
    const envelope = await seal(text, a.publicKey);
    expect(JSON.stringify(envelope)).not.toContain('credential');
    expect(await unseal(envelope, a.privateKey)).toBe(text);
    await expect(unseal(envelope, b.privateKey)).rejects.toThrow();
  });
  it('discriminates message input on kind and keeps secret offers metadata-only', () => {
    expect(messageInputSchema.parse({ title: 'Hi' }).kind).toBe('message');
    const secret = messageInputSchema.parse({ title: 'Key', kind: 'secret', fields: [] });
    expect(secret).toMatchObject({ kind: 'secret', fields: [], attachments: [] });
    for (const extra of [
      { fields: [{ id: 'a', label: 'A', type: 'text' }] },
      { blocks: [{ type: 'code', text: 'x' }] },
      { actions: [{ id: 'ok', label: 'OK', values: {} }] },
    ])
      expect(
        messageInputSchema.safeParse({ title: 'Key', kind: 'secret', ...extra }).error?.issues[0]
          .message,
      ).toMatch(/metadata only/);
    expect(messageInputSchema.safeParse({ title: 'X', kind: 'task' }).success).toBe(false);
  });
});
