import { z } from 'zod';
import { answersSchema } from './forms';
import { requestTypeSchema } from './session';
import { messageStatuses, type Message } from './message';
import { actionIdSchema } from './actions';
export * from './session';
export * from './message';
export * from './actions';
export * from './review';
export * from './forms';
export * from './e2ee';
export { jsonSchemaFields } from './json-schema';
export * from './questions';
export const limits = { fileBytes: 100_000_000, secretTTL: 15 * 60_000 };
export const envelopeSchema = z
  .object({ key: z.string().max(1500), iv: z.string().max(30), data: z.string().max(90_000) })
  .strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export const responseSchema = z.object({
  values: answersSchema,
  actionId: actionIdSchema.optional(),
  secrets: z.record(z.string().max(64), envelopeSchema).default({}),
});
export interface ThreadPage {
  messages: Message[];
  next?: number;
}
/** `GET /messages` filter. `exclude` returns messages that do not match status and direction. */
export const messageFilterSchema = z.object({
  status: z.enum(messageStatuses).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  exclude: z.literal('true').optional(),
});
export type MessageFilter = z.infer<typeof messageFilterSchema>;
/** A deleted message in the revision feed (`GET /messages?after=N&tombstones=1`). */
export interface Tombstone {
  id: string;
  revision: number;
  deleted: true;
}
/** Live socket event: the inbox changed up to `revision`; `reconcile` marks deletions. */
export interface SyncEvent {
  type: 'sync';
  revision: number;
  reconcile?: true;
}
export const destinationSchema = z
  .object({
    /** Client-chosen key; registering the same key again updates that destination. */
    key: z.string().min(1).max(120).optional(),
    transport: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('pull') }),
        z.object({ kind: z.literal('webhook'), url: z.string().url().max(2048) }),
      ])
      .optional(),
    description: z.string().max(300).default(''),
    types: z.array(requestTypeSchema).min(1).max(20),
  })
  .superRefine((d, ctx) => {
    if (new Set(d.types.map((t) => t.id)).size !== d.types.length)
      ctx.addIssue({ code: 'custom', message: 'Type IDs must be unique.' });
    if (d.types.some((t) => t.fields.some((f) => ['secret', 'file'].includes(f.type))))
      ctx.addIssue({ code: 'custom', message: 'Use a dedicated secret request for credentials.' });
  });
/** A destination takes its connection's name; a sent `name` is ignored. */
export type DestinationRegistration = z.input<typeof destinationSchema>;
export interface Destination extends z.infer<typeof destinationSchema> {
  id: string;
  integrationId: string;
  /** The owning connection's current name. */
  name: string;
}
export const profileUpdateSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
/** An account's plan. */
export type Plan = 'free' | 'starter' | 'pro';
export interface Account {
  unmetered?: boolean;
  channel?: 'staging' | 'production';
  id: string;
  name: string;
  email: string;
  plan: Plan;
  used: number;
  reserved?: number;
  credits?: number;
  devices?: number;
  storage: number;
  /** When the included allowance next resets: monthly on the billing date on paid plans, else at the UTC month start. */
  usageResetsAt?: string;
  /** @deprecated Same as `usageResetsAt`; removed after one release. */
  renewsAt: string;
}
export const scopes = [
  'messages:send',
  'messages:read',
  'destinations:manage',
  'events:read',
  'files:write',
] as const;
export type Scope = (typeof scopes)[number];
export { connectionColorSchema } from './connection-color';
export type { ConnectionColor } from './connection-color';
export interface Integration {
  color?: import('./connection-color').ConnectionColor;
  id: string;
  name: string;
  scopes: Scope[];
  createdAt: string;
  /** Holds a certified end-to-end key. */
  e2ee?: boolean;
}
