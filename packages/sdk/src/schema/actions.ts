import { z } from 'zod';
import { answersSchema, type Answers } from './forms';
export const actionIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
export const actionSchema = z
  .object({
    id: actionIdSchema,
    label: z
      .string()
      .min(1)
      .max(80)
      .refine((label) => Boolean(label.trim()), 'Action labels cannot be blank.'),
    values: answersSchema,
  })
  .strict();
export type RequestAction = z.infer<typeof actionSchema>;
export function matchesAction(
  actions: RequestAction[] | undefined,
  id: string,
  values: Answers,
): boolean {
  const action = actions?.find((candidate) => candidate.id === id);
  if (!action || Object.keys(action.values).length !== Object.keys(values).length) return false;
  return Object.entries(action.values).every(([key, expected]) => {
    const actual = values[key];
    return Array.isArray(expected)
      ? Array.isArray(actual) &&
          expected.length === actual.length &&
          expected.every((v, i) => v === actual[i])
      : actual === expected;
  });
}
