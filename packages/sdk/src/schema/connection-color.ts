import { z } from 'zod';

export const connectionColorSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('neutral') }).strict(),
  z
    .object({
      mode: z.literal('custom'),
      hue: z.number().finite().min(0).lt(360),
      saturation: z.number().finite().min(0).max(100),
    })
    .strict(),
]);
export type ConnectionColor = z.infer<typeof connectionColorSchema>;
