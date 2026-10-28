import { z } from 'zod';
import { answersSchema, fieldsSchema, validateAnswers, type Answers, type Field } from './forms';

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
const option = z
  .object({ value: z.string().min(1).max(100), label: z.string().min(1).max(120) })
  .strict();
const choice = z
  .object({
    label: z.string().min(1).max(120),
    description: z.string().max(300).optional(),
    options: z.array(option).min(1).max(50),
    default: z.string().max(100).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.options.map((item) => item.value)).size !== value.options.length)
      ctx.addIssue({ code: 'custom', message: 'Choice values must be unique.' });
    if (value.default !== undefined && !value.options.some((item) => item.value === value.default))
      ctx.addIssue({ code: 'custom', message: 'Default must be an available choice.' });
  });
export const sessionOptionsSchema = z
  .object({
    prompt: z
      .object({
        placeholder: z.string().max(120).optional(),
        maxLength: z.number().int().min(1).max(16000).optional(),
      })
      .strict()
      .optional(),
    attachments: z
      .object({ maxFiles: z.number().int().min(1).max(10) })
      .strict()
      .optional(),
    modes: z.array(choice.safeExtend({ id })).max(6).optional(),
    model: choice.optional(),
    effort: choice.optional(),
    commands: z
      .array(
        z
          .object({
            id,
            label: z.string().min(1).max(80),
            description: z.string().max(300).optional(),
            arguments: fieldsSchema.default([]),
          })
          .strict(),
      )
      .max(30)
      .optional(),
  })
  .strict()
  .superRefine((options, ctx) => {
    for (const items of [options.modes, options.commands]) {
      if (items && new Set(items.map((item) => item.id)).size !== items.length)
        ctx.addIssue({ code: 'custom', message: 'Mode and command IDs must be unique.' });
    }
    for (const command of options.commands || []) {
      if (
        command.arguments.some(
          (field) => ['file', 'secret', 'annotations'].includes(field.type) || field.id.length > 40,
        )
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Command arguments use non-file, non-secret fields with IDs up to 40 characters.',
        });
    }
  });
export type SessionOptions = z.infer<typeof sessionOptionsSchema>;
export const reservedSessionField = (id: string) =>
  ['prompt', 'attachments', 'model', 'effort', 'command'].includes(id) ||
  /^(mode_|argument_)/.test(id);
export const requestTypeSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
    label: z.string().min(1).max(80),
    description: z.string().max(300).default(''),
    fields: fieldsSchema.default([]),
    kind: z.literal('session').optional(),
    session: sessionOptionsSchema.optional(),
  })
  .superRefine((type, ctx) => {
    if (type.session && type.kind !== 'session')
      ctx.addIssue({ code: 'custom', message: 'Session options require kind: session.' });
    if (type.kind === 'session' && type.fields.some((field) => reservedSessionField(field.id)))
      ctx.addIssue({
        code: 'custom',
        message: 'Custom fields must not use reserved session field IDs.',
      });
    if (
      type.kind === 'session' &&
      requestTypeFields(type).length +
        Math.max(0, ...(type.session?.commands || []).map((command) => command.arguments.length)) >
        30
    )
      ctx.addIssue({
        code: 'custom',
        message: 'A session may contain at most 30 fields, including command arguments.',
      });
  });
export type RequestType = z.infer<typeof requestTypeSchema>;

export function requestTypeFields(type: RequestType, values: Answers = {}): Field[] {
  if (type.kind !== 'session') return type.fields;
  const config = type.session || {};
  const fields: Field[] = [
    {
      id: 'prompt',
      label: 'Prompt',
      type: 'textarea',
      required: true,
      placeholder: config.prompt?.placeholder || 'What would you like to work on?',
      maxLength: config.prompt?.maxLength || 16000,
    },
  ];
  if (config.attachments)
    fields.push({
      id: 'attachments',
      label: 'Attachments',
      type: 'file',
      required: false,
      maxItems: config.attachments.maxFiles,
      uniqueItems: true,
    });
  for (const item of config.modes || [])
    fields.push({
      ...item,
      id: 'mode_' + item.id,
      help: item.description,
      type: 'select',
      required: false,
    });
  for (const name of ['model', 'effort'] as const) {
    const item = config[name];
    if (item)
      fields.push({ ...item, id: name, help: item.description, type: 'select', required: false });
  }
  if (config.commands?.length) {
    fields.push({
      id: 'command',
      label: 'Command',
      type: 'select',
      required: false,
      options: config.commands.map((command) => ({ value: command.id, label: command.label })),
    });
    const command = config.commands.find((item) => item.id === values.command);
    fields.push(
      ...(command?.arguments || []).map((field) => ({ ...field, id: 'argument_' + field.id })),
    );
  }
  return [...fields, ...type.fields];
}

export function validateRequestValues(type: RequestType, values: Answers) {
  const errors = validateAnswers(requestTypeFields(type, values), values);
  if (type.kind === 'session' && (typeof values.prompt !== 'string' || !values.prompt.trim()))
    errors.prompt = 'Enter a prompt.';
  return errors;
}

/** Stable, harness-neutral payload carried with the normal queued task. */
export interface SessionRequest {
  prompt: string;
  modes: Record<string, string>;
  model?: string;
  effort?: string;
  command?: { id: string; arguments: Answers };
}
export function sessionRequest(type: RequestType, values: Answers): SessionRequest | undefined {
  if (type.kind !== 'session') return undefined;
  const options = type.session || {};
  const command = options.commands?.find((item) => item.id === values.command);
  return {
    prompt: String(values.prompt),
    modes: Object.fromEntries(
      (options.modes || [])
        .filter((mode) => values['mode_' + mode.id] !== undefined)
        .map((mode) => [mode.id, String(values['mode_' + mode.id])]),
    ),
    ...(values.model !== undefined ? { model: String(values.model) } : {}),
    ...(values.effort !== undefined ? { effort: String(values.effort) } : {}),
    ...(command
      ? {
          command: {
            id: command.id,
            arguments: Object.fromEntries(
              command.arguments
                .filter((field) => values['argument_' + field.id] !== undefined)
                .map((field) => [field.id, values['argument_' + field.id]]),
            ),
          },
        }
      : {}),
  };
}

/** The typed session part of a `POST /outbox` request; `attachments` are uploaded file IDs. */
export const sessionInputSchema = z
  .object({
    prompt: z.string().max(16000),
    modes: z.record(z.string().max(40), z.string().max(100)).default({}),
    model: z.string().max(100).optional(),
    effort: z.string().max(100).optional(),
    command: z
      .object({ id: z.string().max(40), arguments: answersSchema.default({}) })
      .strict()
      .optional(),
    attachments: z.array(z.string().uuid()).max(10).optional(),
  })
  .strict();
export type SessionInput = z.input<typeof sessionInputSchema>;
const prefixed = (prefix: string, values: Answers) =>
  Object.fromEntries(Object.entries(values).map(([id, value]) => [prefix + id, value]));
/** Form values for a typed session payload, as `requestTypeFields` names them. */
export function sessionValues(session: z.output<typeof sessionInputSchema>): Answers {
  return {
    prompt: session.prompt,
    ...(session.attachments ? { attachments: session.attachments } : {}),
    ...prefixed('mode_', session.modes),
    ...(session.model !== undefined ? { model: session.model } : {}),
    ...(session.effort !== undefined ? { effort: session.effort } : {}),
    ...(session.command
      ? { command: session.command.id, ...prefixed('argument_', session.command.arguments) }
      : {}),
  };
}
/** Splits form values into the typed `POST /outbox` payload: custom values plus the session. */
export function taskPayload(
  type: RequestType,
  values: Answers,
): { values: Answers; session?: SessionInput } {
  const session = sessionRequest(type, values);
  if (!session) return { values };
  const files = values.attachments;
  return {
    values: Object.fromEntries(Object.entries(values).filter(([id]) => !reservedSessionField(id))),
    session: {
      ...session,
      ...(Array.isArray(files) && files.length ? { attachments: files as string[] } : {}),
    },
  };
}
