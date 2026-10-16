import { z } from 'zod';
// Wire shapes for end-to-end encryption. The server stores these opaquely.
const b64u = (max: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]*$/)
    .max(max);
const kid = b64u(22).min(22);
const key32 = b64u(43).min(43);
const ctxValue = z.union([z.string().max(200), z.number().int()]);
export const recipientSchema = z.object({ kid, enc: key32, key: b64u(64) }).strict();
export type Recipient = z.infer<typeof recipientSchema>;
export const sealedEnvelopeSchema = z
  .object({
    v: z.literal(1),
    ctx: z
      .object({ t: z.string().min(1).max(32), account: z.string().min(1).max(200) })
      .catchall(ctxValue),
    from: kid,
    to: z.array(recipientSchema).min(1).max(16),
    iv: b64u(16).min(16),
    ct: b64u(180_000).min(22),
    sig: b64u(86).min(86),
  })
  .strict();
export type SealedEnvelope = z.infer<typeof sealedEnvelopeSchema>;
const iso = z.string().datetime();
export const accountStatementSchema = z
  .object({
    v: z.literal(1),
    account: z.string().min(1).max(200),
    identity: key32,
    inbox: key32,
    created: iso,
  })
  .strict();
export const accountKeysSchema = z
  .object({ statement: accountStatementSchema, sig: b64u(86).min(86) })
  .strict();
export type AccountKeys = z.infer<typeof accountKeysSchema>;
export const certificateBodySchema = z
  .object({
    v: z.literal(1),
    account: z.string().min(1).max(200),
    kid,
    sign: key32,
    box: key32,
    created: iso,
  })
  .strict();
export const certificateSchema = z
  .object({ certificate: certificateBodySchema, sig: b64u(86).min(86) })
  .strict();
export type Certificate = z.infer<typeof certificateSchema>;
export const wrappedKeyringSchema = z
  .object({
    v: z.literal(1),
    kind: z.enum(['prf', 'recovery']),
    credentialId: b64u(1400).optional(),
    iv: b64u(16).min(16),
    ct: b64u(20_000),
  })
  .strict();
export type WrappedKeyring = z.infer<typeof wrappedKeyringSchema>;
/** An owner device's extra recipient entry for an existing envelope (thread access). */
export const grantSchema = z
  .object({ message: z.string().uuid() })
  .extend(recipientSchema.shape)
  .strict();
export type Grant = z.infer<typeof grantSchema>;
/**
 * `POST /messages` from a keyed integration: content sealed, routing metadata in the clear. `id`
 * is the new record's UUID, chosen by the sender and bound into the envelope. `kind: 'secret'`
 * seals a secret offer's title and body; it never asks and carries no attachments.
 */
export const sealedMessageInputSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['message', 'secret']).default('message'),
    sealed: sealedEnvelopeSchema,
    digest: b64u(43).min(43),
    asks: z.boolean(),
    attachments: z
      .array(z.object({ id: z.string().uuid() }).strict())
      .max(10)
      .default([]),
    taskId: z.string().uuid().optional(),
    replyTo: z.string().uuid().optional(),
    expiresAt: iso.optional(),
    expiresIn: z.number().positive().max(86400).optional(),
  })
  .strict()
  .refine((m) => !(m.expiresAt && m.expiresIn), 'Use expiresAt or expiresIn, not both.')
  .refine(
    (m) => m.kind !== 'secret' || (!m.asks && !m.attachments.length),
    'A sealed secret offer cannot ask or carry attachments.',
  );
export type SealedMessageInput = z.infer<typeof sealedMessageInputSchema>;
/**
 * `POST /messages/:id/response` to a sealed request. Secrets go to the asker only, once;
 * `secretFiles` are the uploads whose keys only those secrets carry.
 */
export const sealedResponseSchema = z
  .object({
    sealed: sealedEnvelopeSchema,
    secrets: z.record(z.string().max(64), sealedEnvelopeSchema).default({}),
    files: z.array(z.string().uuid()).max(30).default([]),
    secretFiles: z.array(z.string().uuid()).max(30).default([]),
  })
  .strict();
/** `POST /outbox` to a keyed destination. `id` is the task's UUID, bound into the envelope. */
export const sealedOutboxSchema = z
  .object({
    id: z.string().uuid(),
    destinationId: z.string().uuid(),
    typeId: z.string().min(1).max(64),
    sealed: sealedEnvelopeSchema,
    files: z.array(z.string().uuid()).max(30).default([]),
    grants: z.array(grantSchema).max(500).default([]),
    replyTo: z.string().uuid().optional(),
    expiresIn: z.number().positive().max(86400).optional(),
  })
  .strict();
/** Device approval: the locked device commits, the approver challenges, the device reveals. */
export const pendingDeviceInputSchema = z
  .object({ label: z.string().trim().min(1).max(80), commit: key32 })
  .strict();
export const deviceChallengeSchema = z.object({ nonce: key32 }).strict();
export const deviceRevealSchema = z.object({ transfer: key32, nonce: key32 }).strict();
export const deviceApprovalSchema = z.object({ envelope: sealedEnvelopeSchema }).strict();
export interface PendingDevice {
  id: string;
  label: string;
  state: 'waiting' | 'challenged' | 'revealed' | 'approved' | 'rejected';
  createdAt: string;
  expiresAt: string;
  commit: string;
  challenge?: string;
  transfer?: string;
  nonce?: string;
}
/** `GET /keys`. `account` is null until the owner enrols. */
export interface KeyDirectory {
  account: AccountKeys | null;
  certificates: (Certificate & { integrationId: string })[];
}
export interface KeyBackup {
  id: string;
  wrapped: WrappedKeyring;
  createdAt: string;
}
