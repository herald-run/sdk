/**
 * Sealed records for client tests, keyed to the contract fixtures' token: what a server returns
 * for that connection's messages, the owner's answers and tasks to it.
 */
import * as e2ee from '../src/e2ee/index';
import type { KeyDirectory, Message, SealedEnvelope } from '../src/schema/index';
import { sealedContracts } from './contracts';
const { token, keyring, steps } = sealedContracts;
export { token };
export const auth = token.split('.')[0];
export const directory = steps.find((s) => s.name === 'keys')!.response.body as KeyDirectory;
/** The token's own connection. */
export const runnerId = directory.certificates[0].integrationId;
type Ctx = Record<string, string | number> & { t: string };
type Payload = Record<string, unknown>;
async function keys() {
  const owner = await e2ee.keyringKeys(keyring);
  const me = await e2ee.keySet(e2ee.parseToken(token).seed);
  return {
    owner,
    me,
    to: [
      { kid: owner.inboxKid, box: owner.inbox[0].boxPub },
      { kid: me.kid, box: me.boxPub },
    ],
    identity: { kid: owner.signerKid, signPriv: owner.identity.signPriv },
  };
}
async function seal(payload: Payload, ctx: Ctx, by: 'owner' | 'runner') {
  const k = await keys();
  const signer = by === 'owner' ? k.identity : k.me;
  return e2ee.seal({ payload, ctx: { ...ctx, account: keyring.account }, signer, to: k.to });
}
const placeholders = (record: Partial<Message>) =>
  ({
    title: 'Encrypted message',
    body: '',
    kind: 'message',
    fields: [],
    attachments: [],
    sender: 'Runner',
    senderId: runnerId,
    direction: 'inbound',
    status: 'pending',
    createdAt: new Date().toISOString(),
    read: false,
    archived: false,
    ...record,
  }) as Message;
/** The record a server stores for a sealed `POST /messages` body. */
export const stored = (body: {
  id: string;
  kind?: string;
  sealed: SealedEnvelope;
  asks: boolean;
}) =>
  placeholders({
    id: body.id,
    kind: (body.kind || 'message') as Message['kind'],
    sealed: body.sealed,
    status: body.asks || body.kind === 'secret' ? 'pending' : 'delivered',
  });
/** A message from this connection as stored: placeholders, with `content` sealed. */
export async function sealedMessage(content: Payload, record: Partial<Message> = {}) {
  const id = record.id || crypto.randomUUID();
  const payload = { v: 1, kind: 'message', attachments: [], ...content };
  return placeholders({
    kind: payload.kind === 'secret' ? 'secret' : 'message',
    ...record,
    id,
    sealed: await seal(payload, { t: 'message', id }, 'runner'),
  });
}
/** `m` answered by the owner; `secretFields` were answered through secret envelopes. */
export async function sealedAnswer(
  m: Message,
  values: Payload,
  {
    actionId,
    secretFields = [],
    attachments,
  }: { actionId?: string; secretFields?: string[]; attachments?: Payload[] } = {},
) {
  const ctx = { t: 'response', message: m.id, request: await e2ee.envelopeDigest(m.sealed!) };
  const payload = {
    v: 1,
    values,
    ...(actionId ? { actionId } : {}),
    ...(attachments && { attachments }),
  };
  const sealed = await seal(payload, ctx, 'owner');
  return {
    ...m,
    status: 'answered',
    response: { values: {}, secretFields, createdAt: m.createdAt, sealed },
  } as Message;
}
/** An owner's task to this connection. */
export async function sealedTask(input: Payload, record: Partial<Message> = {}) {
  const id = record.id || crypto.randomUUID();
  const destinationId = record.destinationId || crypto.randomUUID();
  const typeId = record.typeId || 'run';
  const ctx = { t: 'task', id, destination: destinationId, type: typeId };
  const sealed = await seal({ v: 1, values: {}, ...input }, ctx, 'owner');
  return {
    title: 'Run',
    body: '',
    kind: 'message',
    fields: [],
    attachments: [],
    sender: 'Runner',
    senderId: runnerId,
    recipientId: runnerId,
    direction: 'outbound',
    status: 'queued',
    createdAt: new Date().toISOString(),
    read: false,
    archived: false,
    execution: { attempt: 0 },
    ...record,
    id,
    destinationId,
    typeId,
    input: { destinationId, typeId, values: {}, sealed },
    response: { values: {}, secretFields: [], createdAt: new Date().toISOString() },
  } as Message;
}
/** A secret answer the owner sealed to this connection only: text, or a secret file field's files. */
export async function sealedSecret(message: string, field: string, value: string | Payload[]) {
  const k = await keys();
  const ctx = { t: 'secret', account: keyring.account, message, field };
  const payload = { v: 1, ...(typeof value === 'string' ? { value } : { files: value }) };
  return e2ee.seal({ payload, ctx, signer: k.identity, to: [k.to[1]] });
}
/** A secret receiver claimed by an owner device, signed by the account. */
export const signedReceiver = async (message: string, publicKey: JsonWebKey) => {
  const claimId = crypto.randomUUID();
  const sig = await e2ee.signReceiver(keyring, { message, claimId, publicKey });
  return { claimId, publicKey, sig };
};
/** A task log line sealed by this connection. */
export async function sealedLog(task: string, sequence: number, text: string) {
  const sealed = await seal({ v: 1, text }, { t: 'log', task, seq: sequence }, 'runner');
  return { sequence, stream: 'stdout' as const, text: '', sealed };
}
/** Opens what this connection sealed, as the owner. */
export async function opened(envelope: SealedEnvelope): Promise<Payload> {
  const k = await keys();
  return e2ee.open(envelope, {
    recipients: [k.owner.inbox[0]],
    signers: (kid) => (kid === k.me.kid ? k.me.signPub : undefined),
    expect: { t: envelope.ctx.t, account: keyring.account },
  });
}
