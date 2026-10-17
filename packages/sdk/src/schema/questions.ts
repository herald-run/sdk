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
  .max(30);
export type Question = z.infer<typeof questionsSchema>[number];
export type QuestionsRequest = z.input<typeof questionsSchema>;

/** Required choice fields `q1`…`qN` with Other; option values are their labels. */
export function questionFields(questions: Question[]): Field[] {
  return questions.map((q, i) => ({
    id: `q${i + 1}`,
    label: q.question.length > 120 ? q.question.slice(0, 119) + '…' : q.question,
    ...(q.question.length > 120 ? { help: q.question } : {}),
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

/** Answers keyed by question text: chosen labels joined by ", ", or the Other text. */
export function questionAnswers(questions: Question[], values: Answers): Record<string, string> {
  return Object.fromEntries(
    questions.map((q, i) => {
      const value = values[`q${i + 1}`];
      return [q.question, Array.isArray(value) ? value.join(', ') : String(value ?? '')];
    }),
  );
}
