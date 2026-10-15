import { z } from 'zod';
const title = z.string().max(180).optional();
export const reviewImageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const reviewBlockSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.enum(['code', 'diff', 'json']),
      title,
      requiresReview: z.boolean().optional(),
      language: z
        .enum(['text', 'sql', 'javascript', 'typescript', 'python', 'json'])
        .default('text'),
      text: z.string().max(50_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      title,
      requiresReview: z.boolean().optional(),
      columns: z.array(z.string().min(1).max(120)).min(1).max(12),
      rows: z.array(z.array(z.string().max(2_000)).max(12)).max(100),
    })
    .strict()
    .superRefine((table, ctx) => {
      if (table.rows.some((row) => row.length !== table.columns.length))
        ctx.addIssue({ code: 'custom', message: 'Table rows must match the columns.' });
      if ([...table.columns, ...table.rows.flat()].reduce((n, cell) => n + cell.length, 0) > 50_000)
        ctx.addIssue({ code: 'custom', message: 'Table content exceeds 50,000 characters.' });
    }),
  z
    .object({
      type: z.literal('image'),
      title,
      requiresReview: z.boolean().optional(),
      attachmentId: z.string().uuid(),
      alt: z.string().max(500),
    })
    .strict(),
]);
export type ReviewBlock = z.infer<typeof reviewBlockSchema>;
export const reviewBlockTypes = ['code', 'diff', 'json', 'table', 'image'] as const;
