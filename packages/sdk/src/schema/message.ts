import { z } from 'zod';
import { fieldsSchema, validateAnswers, type Answers, type Field } from './forms';
import { jsonSchemaFields } from './json-schema';
import { actionSchema, type RequestAction } from './actions';
import { reviewBlockSchema, reviewImageTypes, type ReviewBlock } from './review';
import type { SessionInput, SessionRequest } from './session';
import type { SealedEnvelope } from './e2ee';
export const publicKeySchema = z
  .object({
    kty: z.literal('RSA'),
    n: z.string().min(300).max(1400),
    e: z.literal('AQAB'),
    alg: z.literal('RSA-OAEP-256').optional(),
    ext: z.boolean().optional(),
    key_ops: z.array(z.literal('encrypt')).optional(),
  })
  .strict();
export const attachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(200),
  size: z.number().int().nonnegative(),
  type: z.string().max(120),
});
export type Attachment = z.infer<typeof attachmentSchema>;

const common = {
  title: z.string().min(1).max(180),
  body: z.string().max(50_000).default(''),
  runId: z.string().max(120).optional(),
  checkpointId: z.string().max(120).optional(),
  taskId: z.string().uuid().optional(),
  replyTo: z.string().uuid().optional(),
  requiresReview: z.boolean().optional(),
  group: z.string().max(120).optional(),
  expiresAt: z.string().datetime().optional(),
  expiresIn: z.number().positive().max(86400).optional(),
};
const contentInputSchema = z.object({
  ...common,
  kind: z.enum(['message', 'form', 'report', 'files']).default('message'),
  fields: fieldsSchema.default([]),
  schema: z.record(z.string(), z.unknown()).optional(),
  blocks: z.array(reviewBlockSchema).max(10).optional(),
  actions: z.array(actionSchema).min(1).max(8).optional(),
  attachments: z.array(attachmentSchema).max(10).default([]),
  publicKey: publicKeySchema.optional(),
});
const metadataOnly =
  'Secret deliveries contain metadata only; use the encrypted delivery endpoint.';
// Older senders may pass empty arrays; anything else is content a secret offer cannot carry.
const none = z
  .custom<never[]>((v) => Array.isArray(v) && !v.length, metadataOnly)
  .optional()
  .transform((): never[] => []);
const absent = z.undefined({ error: metadataOnly }).optional();
const secretInputSchema = z.object({
  ...common,
  kind: z.literal('secret'),
  fields: none,
  attachments: none,
  schema: absent,
  blocks: none.transform(() => undefined),
  actions: absent,
  publicKey: absent,
});
/** `POST /messages` input: a discriminated union on `kind` (default `message`). */
export const messageInputSchema = z
  .discriminatedUnion('kind', [contentInputSchema, secretInputSchema])
  .transform((m, ctx) => {
    if (m.kind !== 'secret' && m.schema) {
      if (m.fields.length) {
        ctx.addIssue({ code: 'custom', message: 'Use schema or fields, not both.' });
        return z.NEVER;
      }
      try {
        m.fields = jsonSchemaFields(m.schema);
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: (e as Error).message });
        return z.NEVER;
      }
    }
    return m;
  })
  .superRefine((m, ctx) => {
    if (m.expiresAt && m.expiresIn)
      ctx.addIssue({ code: 'custom', message: 'Use expiresAt or expiresIn, not both.' });
    for (const block of m.blocks || []) {
      if (block.type === 'json') {
        try {
          JSON.parse(block.text);
        } catch {
          ctx.addIssue({ code: 'custom', message: 'JSON review blocks must contain valid JSON.' });
        }
      }
      if (block.type === 'image') {
        const attachment = m.attachments.find((file) => file.id === block.attachmentId);
        if (!attachment || !reviewImageTypes.some((type) => type === attachment.type))
          ctx.addIssue({
            code: 'custom',
            message: 'Image blocks require an attached PNG, JPEG, GIF or WebP file.',
          });
      }
    }
    if (m.actions?.length) {
      if (new Set(m.actions.map((a) => a.id)).size !== m.actions.length)
        ctx.addIssue({ code: 'custom', message: 'Action IDs must be unique.' });
      for (const action of m.actions)
        if (
          m.fields.some((f) => ['secret', 'file'].includes(f.type)) ||
          Object.keys(validateAnswers(m.fields, action.values)).length
        )
          ctx.addIssue({
            code: 'custom',
            message: 'Actions must completely answer a form without secrets or files.',
          });
    }
    if (m.fields.some((f) => f.type === 'secret') && !m.publicKey)
      ctx.addIssue({ code: 'custom', message: 'Secret fields require a requester public key.' });
  });
export type MessageInput = z.infer<typeof messageInputSchema>;
export type MessageRequest = z.input<typeof messageInputSchema>;
export type MessageKind = MessageInput['kind'];

export const messageStatuses = [
  'pending',
  'answered',
  'delivered',
  'expired',
  'cancelled',
  'queued',
  'running',
  'completed',
  'failed',
] as const;
export type MessageStatus = (typeof messageStatuses)[number];
export interface TaskLog {
  sequence: number;
  stream: 'stdout' | 'stderr';
  text: string;
  /** End-to-end encrypted chunk (`ctx.t = "log"`); `text` is empty. */
  sealed?: SealedEnvelope;
}
export interface TaskExecution {
  attempt: number;
  acknowledgedAt?: string;
  completedAt?: string;
  error?: string;
  /** @deprecated Read `GET /messages/:id/logs`. */
  logs?: TaskLog[];
}
/** `POST /outbox` input as stored: custom field values plus the typed session, if any. */
export interface TaskInput {
  destinationId: string;
  typeId: string;
  values: Answers;
  session?: SessionInput;
  /** End-to-end encrypted `values` and `session` (`ctx.t = "task"`). */
  sealed?: SealedEnvelope;
}
/** How a task ended, as its runner reported it. */
export interface TaskResult {
  status: 'completed' | 'failed';
  completedAt: string;
  error?: string;
  /** End-to-end encrypted error (`ctx.t = "result"`). */
  sealed?: SealedEnvelope;
}
/** Stored content. Input-only fields (`schema`, `expiresIn`, `taskId`) are never stored. */
interface StoredContent {
  title: string;
  body: string;
  kind: MessageKind;
  fields: Field[];
  attachments: Attachment[];
  blocks?: ReviewBlock[];
  actions?: RequestAction[];
  publicKey?: z.infer<typeof publicKeySchema>;
  requiresReview?: boolean;
  runId?: string;
  checkpointId?: string;
  replyTo?: string;
  group?: string;
  expiresAt?: string;
}
interface StoredRecord extends StoredContent {
  id: string;
  threadId?: string;
  threadSequence?: number;
  /** The integration that sent it; on tasks (legacy) the recipient, see `recipientId`. */
  sender: string;
  senderId: string;
  createdAt: string;
  revision?: number;
  read: boolean;
  archived: boolean;
  status: MessageStatus;
  /** On tasks (legacy) the flattened task input; see `input`. */
  response?: {
    values: Answers;
    actionId?: string;
    secretFields: string[];
    createdAt: string;
    /** End-to-end encrypted `values` and `actionId` (`ctx.t = "response"`). */
    sealed?: SealedEnvelope;
  };
  deleteAt?: string;
  /** End-to-end encrypted content (`ctx.t = "message"`); content fields hold placeholders. */
  sealed?: SealedEnvelope;
}
export interface InboundMessage extends StoredRecord {
  direction: 'inbound';
  secretDelivery?: 'offered' | 'claimed' | 'ready' | 'received';
}
/** An owner-sent task (`POST /outbox`) for the integration behind `recipientId`. */
export interface Task extends StoredRecord {
  direction: 'outbound';
  kind: 'message';
  recipientId: string;
  destinationId: string;
  typeId: string;
  input: TaskInput;
  result?: TaskResult;
  session?: SessionRequest;
  execution?: TaskExecution;
}
/** A stored record; `direction` discriminates messages from tasks. */
export type StoredMessage = InboundMessage | Task;
/** What a list projection (`view=summary`) left out; read the detail for the full record. */
export interface MessageProjection {
  blocks: Pick<ReviewBlock, 'type' | 'requiresReview'>[];
  logs: number;
}
/** A client's view of any record: full, a list projection, or cached before newer fields. */
export interface Message extends StoredRecord {
  direction: 'inbound' | 'outbound';
  secretDelivery?: InboundMessage['secretDelivery'];
  recipientId?: string;
  destinationId?: string;
  typeId?: string;
  input?: TaskInput;
  result?: TaskResult;
  session?: SessionRequest;
  execution?: TaskExecution;
  projection?: MessageProjection;
}
