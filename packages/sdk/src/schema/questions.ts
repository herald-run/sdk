import { z } from 'zod';
import type { Answers, Field } from './forms';
/** Agent-style multiple-choice questions (the shape of Claude Code's AskUserQuestion input). */
export const questionsSchema = z
  .array(
    z.object({
      question: z.string().trim().min(1).max(300),
      header: z.string().trim().min(1).max(24).optional(),
      options: z
        .array(
          z.object({
            label: z.string().trim().min(1).max(100),
            description: z.string().max(300).optional(),
            preview: z.string().max(4000).optional(),
          }),
        )
        .min(1)
        .max(50)
        .refine(
          (options) => new Set(options.map((o) => o.label)).size === options.length,
          'Option labels must be unique.',
        ),
      multiSelect: z.boolean().default(false),
    }),
  )
  .min(1)
  .max(30)
  .refine(
    (questions) => new Set(questions.map((q) => q.question)).size === questions.length,
    'Each question must be unique.',
  );
export type Question = z.infer<typeof questionsSchema>[number];
export type QuestionsRequest = z.input<typeof questionsSchema>;

/** Labels hold 120 code points (as zod counts): longer text keeps 119 and an ellipsis. */
function label(text: string) {
  const points = [...text];
  return points.length > 120 ? points.slice(0, 119).join('') + '…' : text;
}

/** Required choice fields `q1`…`qN` with Other; option values are their labels. */
export function questionFields(questions: Question[]): Field[] {
  return questions.map((q, i) => ({
    id: `q${i + 1}`,
    label: label(q.question),
    ...(label(q.question) !== q.question ? { help: q.question } : {}),
    ...(q.header ? { header: q.header } : {}),
    type: q.multiSelect ? 'multiselect' : 'select',
    required: true,
    other: true,
    options: q.options.map(({ label, description, preview }) => ({
      value: label,
      label,
      ...(description ? { description } : {}),
      ...(preview ? { preview } : {}),
    })),
  }));
}

function answersFor(texts: string[], values: Answers): Record<string, string> {
  return Object.fromEntries(
    texts.map((text, i) => {
      const value = values[`q${i + 1}`];
      return [text, Array.isArray(value) ? value.join(', ') : String(value ?? '')];
    }),
  );
}

/** Answers keyed by question text: chosen labels joined by ", ", or the Other text. */
export function questionAnswers(questions: Question[], values: Answers): Record<string, string> {
  return answersFor(
    questions.map((q) => q.question),
    values,
  );
}

/** `questionAnswers` rebuilt from a request's fields; undefined unless they came from `questionFields`. */
export function fieldAnswers(fields: Field[], values: Answers): Record<string, string> | undefined {
  const asked =
    fields.length > 0 &&
    fields.every(
      (f, i) =>
        f.id === `q${i + 1}` && f.other === true && ['select', 'multiselect'].includes(f.type),
    );
  if (!asked) return undefined;
  const text = (f: Field) => (f.label.endsWith('…') && f.help ? f.help : f.label);
  return answersFor(fields.map(text), values);
}
