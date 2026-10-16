import { z } from 'zod';
// No eval-compiled parsers: the app CSP forbids eval, and the probe would log a violation.
z.config({ jitless: true });
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
export const fieldSchema = z.object({
  id: key,
  label: z.string().min(1).max(120),
  type: z.enum([
    'text',
    'textarea',
    'number',
    'select',
    'multiselect',
    'boolean',
    'date',
    'secret',
    'file',
  ]),
  default: z
    .union([
      z.string().max(16000),
      z.number().finite(),
      z.boolean(),
      z.array(z.string()).max(50),
      z.null(),
    ])
    .optional(),
  nullable: z.boolean().optional(),
  uniqueItems: z.boolean().optional(),
  integer: z.boolean().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  exclusiveMinimum: z.number().optional(),
  exclusiveMaximum: z.number().optional(),
  minLength: z.number().int().min(0).max(16000).optional(),
  maxLength: z.number().int().min(0).max(16000).optional(),
  minItems: z.number().int().min(0).max(50).optional(),
  maxItems: z.number().int().min(0).max(50).optional(),
  required: z.boolean().default(false),
  /** File fields only: the files go to the asker alone, like a secret, and leave no history. */
  secret: z.boolean().optional(),
  help: z.string().max(300).optional(),
  placeholder: z.string().max(120).optional(),
  options: z
    .array(z.object({ value: z.string().max(100), label: z.string().max(120) }))
    .max(50)
    .optional(),
});
export type Field = z.infer<typeof fieldSchema>;
export const fieldsSchema = z
  .array(fieldSchema)
  .max(30)
  .superRefine((fields, ctx) => {
    if (new Set(fields.map((f) => f.id)).size !== fields.length)
      ctx.addIssue({ code: 'custom', message: 'Field IDs must be unique.' });
    for (const f of fields) {
      if (
        (f.minimum !== undefined && f.maximum !== undefined && f.minimum > f.maximum) ||
        // An exclusive bound leaves no value when it meets the opposite bound.
        [
          [f.exclusiveMinimum, f.exclusiveMaximum],
          [f.exclusiveMinimum, f.maximum],
          [f.minimum, f.exclusiveMaximum],
        ].some(([low, high]) => low !== undefined && high !== undefined && low >= high) ||
        (f.minLength !== undefined && f.maxLength !== undefined && f.minLength > f.maxLength) ||
        (f.minItems !== undefined && f.maxItems !== undefined && f.minItems > f.maxItems)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Minimum constraints must not exceed maximum constraints.',
        });
      if ((f.type === 'secret' || f.secret) && f.default !== undefined)
        ctx.addIssue({ code: 'custom', message: 'Secrets cannot have defaults.' });
      if (f.secret && f.type !== 'file')
        ctx.addIssue({ code: 'custom', message: 'Only file fields can be secret.' });
      if (['select', 'multiselect'].includes(f.type) && !f.options?.length)
        ctx.addIssue({ code: 'custom', message: `${f.label} needs choices.` });
      if (
        f.default !== undefined &&
        Object.keys(validateAnswers([f], { [f.id]: f.default })).length
      )
        ctx.addIssue({ code: 'custom', message: `${f.label} has an invalid default.` });
    }
  });
export type Answers = Record<string, string | number | boolean | string[] | null>;
export const answersSchema = z.record(
  z.string().max(64),
  z.union([
    z.string().max(16_000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(z.string().max(100)).max(50),
  ]),
);
export function validateAnswers(
  fields: Field[],
  values: Answers,
  secretIds: string[] = [],
): Record<string, string> {
  const errors: Record<string, string> = {};
  const ids = new Set(fields.map((f) => f.id));
  for (const id of [...Object.keys(values), ...secretIds])
    if (!ids.has(id)) errors[id] = 'Unknown field.';
  for (const f of fields) {
    const v = values[f.id];
    if ((f.type === 'secret' || f.secret) && secretIds.includes(f.id)) continue;
    if (v === null) {
      if (!f.nullable) errors[f.id] = 'Null is not allowed.';
      continue;
    }
    if (v === undefined) {
      if (f.required) errors[f.id] = 'This field is required.';
      continue;
    }
    if (f.required && (v === '' || (Array.isArray(v) && !v.length)))
      errors[f.id] = 'This field is required.';
    if (
      typeof v === 'number' &&
      ((f.integer && !Number.isInteger(v)) ||
        (f.minimum !== undefined && v < f.minimum) ||
        (f.maximum !== undefined && v > f.maximum) ||
        (f.exclusiveMinimum !== undefined && v <= f.exclusiveMinimum) ||
        (f.exclusiveMaximum !== undefined && v >= f.exclusiveMaximum))
    )
      errors[f.id] = 'Number is outside the allowed range.';
    if (
      typeof v === 'string' &&
      ((f.minLength !== undefined && v.length < f.minLength) ||
        (f.maxLength !== undefined && v.length > f.maxLength))
    )
      errors[f.id] = 'Text length is outside the allowed range.';
    if (Array.isArray(v) && f.uniqueItems && new Set(v).size !== v.length)
      errors[f.id] = 'Values must be unique.';
    if (
      Array.isArray(v) &&
      ((f.minItems !== undefined && v.length < f.minItems) ||
        (f.maxItems !== undefined && v.length > f.maxItems))
    )
      errors[f.id] = 'Choose the allowed number of items.';
    if (
      f.type === 'file' &&
      (!Array.isArray(v) ||
        v.length > 10 ||
        v.some((id) => !z.string().uuid().safeParse(id).success))
    )
      errors[f.id] = 'Select valid uploaded files.';
    if (f.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v)))
      errors[f.id] = 'Enter a number.';
    else if (f.type === 'boolean' && typeof v !== 'boolean') errors[f.id] = 'Choose yes or no.';
    else if (
      f.type === 'multiselect' &&
      (!Array.isArray(v) || v.some((x) => !f.options?.some((o) => o.value === x)))
    )
      errors[f.id] = 'Choose from the available options.';
    else if (f.type === 'select' && !f.options?.some((o) => o.value === v))
      errors[f.id] = 'Choose an available option.';
    else if (['text', 'textarea', 'date', 'secret'].includes(f.type) && typeof v !== 'string')
      errors[f.id] = 'Enter text.';
    else if (f.type === 'date') {
      const date = new Date(String(v));
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== v
      )
        errors[f.id] = 'Choose a date.';
    }
  }
  return errors;
}

export function defaultAnswers(fields: Field[]): Answers {
  return Object.fromEntries(
    fields
      .filter((f) => f.default !== undefined)
      .map((f) => [f.id, Array.isArray(f.default) ? [...f.default] : f.default!]),
  );
}
