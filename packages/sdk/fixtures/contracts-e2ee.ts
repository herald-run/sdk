/**
 * Generates the `e2ee` section of `contracts.json`: a keyed integration's scenario with fixed
 * randomness, so every envelope is reproducible. Regenerate with `pnpm contracts:e2ee`.
 */
import { createHash } from 'node:crypto';
import { b64u } from '../src/e2ee/bytes';
import * as e2ee from '../src/e2ee/index';
import { setTestHooks } from '../src/e2ee/random';
import contracts from './contracts.json';
export const NOW = '2030-01-01T00:00:00.000Z';
const ACCOUNT = 'acct-contracts';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [RUNNER, MAILER, FILE, MESSAGE, TAMPERED, LOCKED, SECRET, TASK, DEST, OFFER] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
].map(id);
const [REPLAYED, PLAIN, PLAIN_TASK] = [12, 13, 14].map(id);
const octet = 'application/octet-stream';
const record = (fields: Record<string, unknown>) => ({
  title: 'Encrypted message',
  body: '',
  kind: 'message',
  fields: [],
  attachments: [],
  sender: 'Runner',
  senderId: RUNNER,
  direction: 'inbound',
  status: 'pending',
  createdAt: NOW,
  read: false,
  archived: false,
  ...fields,
});
function flip(text: string) {
  const bytes = b64u.decode(text);
  bytes[0] ^= 1;
  return b64u.encode(bytes);
}
export async function generateSealedContracts() {
  let counter = 0;
  const random = (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 32)
      out.set(
        createHash('sha256')
          .update(`herald e2ee contracts ${counter++}`)
          .digest()
          .subarray(0, length - i),
        i,
      );
    return out;
  };
  setTestHooks({ random, now: () => NOW });
  try {
    const keyring = e2ee.createKeyring(ACCOUNT);
    const owner = await e2ee.keyringKeys(keyring);
    const [runner, mailer] = [await e2ee.keySet(), await e2ee.keySet()];
    const cert = async (set: e2ee.KeySet, integrationId: string) => ({
      integrationId,
      ...(await e2ee.certify(keyring, { sign: set.signPub, box: set.boxPub })),
    });
    const statement = await e2ee.accountStatement(keyring);
    const directory = {
      account: statement,
      certificates: [await cert(runner, RUNNER), await cert(mailer, MAILER)],
    };
    const fp = await e2ee.fingerprint(owner.identity.signPub);
    const inbox = { kid: owner.inboxKid, box: owner.inbox[0].boxPub };
    const self = { kid: runner.kid, box: runner.boxPub };
    const identity = { kid: owner.signerKid, signPriv: owner.identity.signPriv };
    const seal = (
      payload: Record<string, unknown>,
      ctx: Record<string, string | number> & { t: string },
      signer: e2ee.Signer = runner,
      to = [inbox, self],
    ) => e2ee.seal({ payload, ctx: { ...ctx, account: ACCOUNT }, signer, to });

    const fileKey = e2ee.fileKey();
    const notes = { id: FILE, name: 'notes.txt', size: 5, type: 'text/plain' };
    const opaque = { id: FILE, name: 'encrypted', type: octet, size: e2ee.sealedSize(5) };
    const form = {
      title: 'Deploy v2?',
      body: 'Ship **v2** to production.',
      kind: 'form',
      fields: [{ id: 'approve', label: 'Approve', type: 'boolean', required: true }],
    };
    const formPayload = { ...form, attachments: [{ ...notes, key: fileKey }] };
    const formEnv = await seal(formPayload, { t: 'message', id: MESSAGE });
    const expiresAt = '2030-01-01T00:10:00.000Z';
    const sent = record({
      id: MESSAGE,
      attachments: [opaque],
      sealed: formEnv,
      expiresAt,
      threadId: MESSAGE,
      revision: 1,
    });
    const opened = (r: Record<string, unknown>, content: Record<string, unknown>) => ({
      ...r,
      ...content,
      e2ee: true,
    });
    const sentOpen = { ...form, attachments: [{ ...notes, key: fileKey }] };
    const answerEnv = await seal(
      { values: { approve: true } },
      { t: 'response', message: MESSAGE, request: await e2ee.envelopeDigest(formEnv) },
      identity,
    );
    const answer = { values: {}, secretFields: [], createdAt: NOW };
    const answered = {
      ...sent,
      status: 'answered',
      revision: 2,
      response: { ...answer, sealed: answerEnv },
    };
    const answeredOpen = opened(answered, {
      ...sentOpen,
      response: { ...answer, sealed: answerEnv, values: { approve: true } },
    });
    const strip = { title: 'Encrypted message', body: '', fields: [], e2ee: true };
    const forgedEnv = await seal(form, { t: 'message', id: TAMPERED });
    const tampered = record({ id: TAMPERED, sealed: { ...forgedEnv, ct: flip(forgedEnv.ct) } });
    const locked = record({
      id: LOCKED,
      sender: 'Mailer',
      senderId: MAILER,
      sealed: await seal(form, { t: 'message', id: LOCKED }, mailer, [
        inbox,
        { kid: mailer.kid, box: mailer.boxPub },
      ]),
    });
    const secretForm = {
      title: 'Token needed',
      kind: 'form',
      fields: [{ id: 'secret', label: 'Token', type: 'secret', required: true }],
    };
    const secretPayload = { ...secretForm, body: '', attachments: [] };
    const secretEnv = await seal(secretPayload, { t: 'message', id: SECRET });
    const secretRecord = record({ id: SECRET, sealed: secretEnv, threadId: SECRET, revision: 3 });
    const secretValue = await seal(
      { value: 'test-only-token' },
      { t: 'secret', message: SECRET, field: 'secret' },
      identity,
      [self],
    );
    const taskEnv = await seal(
      { values: { prompt: 'Summarize the report' } },
      { t: 'task', id: TASK, destination: DEST, type: 'run' },
      identity,
    );
    const taskInput = { destinationId: DEST, typeId: 'run', values: {} };
    const task = record({
      id: TASK,
      title: 'Run',
      direction: 'outbound',
      status: 'running',
      recipientId: RUNNER,
      destinationId: DEST,
      typeId: 'run',
      runId: TASK,
      threadId: TASK,
      input: { ...taskInput, sealed: taskEnv },
      response: answer,
      execution: { attempt: 1 },
    });
    const taskOpen = (r: Record<string, unknown>) =>
      opened(r, {
        input: { ...taskInput, sealed: taskEnv, values: { prompt: 'Summarize the report' } },
        response: { ...answer, values: { prompt: 'Summarize the report' } },
      });
    const logEnv = await seal({ text: 'hello\n' }, { t: 'log', task: TASK, seq: 0 });
    const errorEnv = await seal({ error: 'boom' }, { t: 'result', task: TASK });
    const failed = {
      ...task,
      status: 'failed',
      result: { status: 'failed', completedAt: NOW, sealed: errorEnv },
      execution: { attempt: 1, completedAt: NOW, sealed: errorEnv },
    };
    const failedOpen = {
      ...taskOpen(failed),
      result: { ...failed.result, error: 'boom' },
      execution: { ...failed.execution, error: 'boom' },
    };
    const bytes = new Uint8Array(
      await new Response(e2ee.sealFile(fileKey, new TextEncoder().encode('hello'))).arrayBuffer(),
    );
    const publicKey = contracts.values.publicKey;
    const claim = { message: OFFER, claimId: id(11), publicKey };
    const receiver = {
      claimId: claim.claimId,
      publicKey,
      sig: await e2ee.signReceiver(keyring, claim),
    };
    const forged = {
      ...receiver,
      sig: await e2ee.signReceiver(e2ee.createKeyring(ACCOUNT), claim),
    };
    const offer = { title: 'Staging key', kind: 'secret' };
    const offerPayload = { kind: 'secret', title: 'Staging key', body: '' };
    const offerEnv = await seal(offerPayload, { t: 'message', id: OFFER });
    const offered = record({
      id: OFFER,
      title: 'Encrypted secret',
      kind: 'secret',
      sealed: offerEnv,
      secretDelivery: 'offered',
      threadId: OFFER,
    });
    // Records a keyed client must not trust: content replayed under another ID, unsealed
    // answers to sealed requests, unsealed records from keyed connections and unsealed tasks.
    const replayed = record({ id: REPLAYED, sealed: formEnv });
    const plainAnswer = { ...answered, response: { ...answer, values: { approve: false } } };
    const plain = record({ id: PLAIN, title: 'Hi', body: 'There', status: 'delivered' });
    const plainTask = { ...task, id: PLAIN_TASK, input: { ...taskInput, values: { prompt: 'x' } } };
    const plainTaskStrip = {
      ...plainTask,
      e2ee: true,
      unverified: true,
      input: { ...taskInput, values: {} },
      response: { ...answer, values: {} },
    };
    const messages = '/api/v1/messages';
    return {
      token: e2ee.formatToken('hdr_test-only', runner.seed, fp),
      keyring,
      steps: [
        {
          name: 'keys',
          request: { method: 'GET', path: '/api/v1/keys' },
          response: { status: 200, body: directory },
          result: directory,
        },
        {
          name: 'upload',
          request: {
            method: 'POST',
            path: '/api/v1/files',
            body: { name: 'encrypted', type: octet, size: opaque.size },
          },
          response: { status: 201, body: opaque },
          upload: {
            path: `/api/v1/files/${FILE}`,
            plain: 'hello',
            response: { status: 200, body: { ok: true } },
          },
          result: { ...notes, key: '<string>' },
        },
        {
          name: 'send',
          input: { ...form, attachments: [{ ...notes, key: fileKey }], expiresIn: 600 },
          request: {
            method: 'POST',
            path: messages,
            headers: { 'Idempotency-Key': 'sealed-1' },
            body: {
              id: MESSAGE,
              kind: 'message',
              sealed: formEnv,
              digest: await e2ee.idempotencyDigest(runner.seed, formPayload, 'sealed-1'),
              asks: true,
              attachments: [{ id: FILE }],
              expiresIn: 600,
            },
          },
          sealed: { sealed: { v: 1, ...formPayload } },
          response: { status: 201, body: sent },
          result: opened(sent, sentOpen),
        },
        {
          name: 'get',
          request: { method: 'GET', path: `${messages}/${MESSAGE}` },
          response: { status: 200, body: answered },
          result: answeredOpen,
        },
        {
          name: 'thread',
          request: { method: 'GET', path: `${messages}/${MESSAGE}/thread?after=0` },
          response: { status: 200, body: { messages: [answered] } },
          result: { messages: [answeredOpen] },
        },
        {
          name: 'get-tampered',
          request: { method: 'GET', path: `${messages}/${TAMPERED}` },
          response: { status: 200, body: tampered },
          result: { ...tampered, ...strip, unverified: true },
        },
        {
          name: 'get-locked',
          request: { method: 'GET', path: `${messages}/${LOCKED}` },
          response: { status: 200, body: locked },
          result: { ...locked, ...strip, locked: true },
        },
        {
          name: 'get-replayed',
          request: { method: 'GET', path: `${messages}/${REPLAYED}` },
          response: { status: 200, body: replayed },
          result: { ...replayed, ...strip, unverified: true },
        },
        {
          name: 'get-unsealed-answer',
          request: { method: 'GET', path: `${messages}/${MESSAGE}` },
          response: { status: 200, body: plainAnswer },
          result: { ...plainAnswer, ...strip, unverified: true, response: answer },
        },
        {
          name: 'get-unsealed-from-keyed',
          request: { method: 'GET', path: `${messages}/${PLAIN}` },
          response: { status: 200, body: plain },
          result: { ...plain, ...strip, unverified: true },
        },
        {
          name: 'send-secret-form',
          input: secretForm,
          request: {
            method: 'POST',
            path: messages,
            headers: { 'Idempotency-Key': 'sealed-2' },
            body: {
              id: SECRET,
              kind: 'message',
              sealed: secretEnv,
              digest: await e2ee.idempotencyDigest(runner.seed, secretPayload, 'sealed-2'),
              asks: true,
              attachments: [],
            },
          },
          sealed: { sealed: { v: 1, ...secretPayload } },
          response: { status: 201, body: secretRecord },
          result: opened(secretRecord, secretPayload),
        },
        {
          name: 'collect-secrets',
          request: { method: 'POST', path: `${messages}/${SECRET}/secrets`, body: {} },
          response: { status: 200, body: { secret: secretValue } },
          result: { secret: 'test-only-token' },
        },
        {
          name: 'claim-task',
          request: {
            method: 'POST',
            path: `/api/v1/tasks/${TASK}/claim`,
            body: { runnerId: 'runner-1', heartbeat: true },
          },
          response: { status: 200, body: { task, lease: 'lease-1', leaseExpiresAt: NOW } },
          result: { task: taskOpen(task), lease: 'lease-1', leaseExpiresAt: NOW },
        },
        {
          name: 'claim-unsealed-task',
          request: {
            method: 'POST',
            path: `/api/v1/tasks/${PLAIN_TASK}/claim`,
            body: { runnerId: 'runner-1', heartbeat: true },
          },
          response: { status: 200, body: { task: plainTask, lease: 'lease-2' } },
          result: { task: plainTaskStrip, lease: 'lease-2' },
        },
        {
          name: 'task-logs',
          input: { lease: 'lease-1', logs: [{ sequence: 0, stream: 'stdout', text: 'hello\n' }] },
          request: {
            method: 'POST',
            path: `/api/v1/tasks/${TASK}/update`,
            headers: { 'Idempotency-Key': `${TASK}:logs:0` },
            body: {
              lease: 'lease-1',
              logs: [{ sequence: 0, stream: 'stdout', text: '', sealed: logEnv }],
            },
          },
          sealed: { 'logs.0.sealed': { v: 1, text: 'hello\n' } },
          response: { status: 200, body: task },
          result: taskOpen(task),
        },
        {
          name: 'read-task-logs',
          request: { method: 'GET', path: `${messages}/${TASK}/logs` },
          response: {
            status: 200,
            body: { logs: [{ sequence: 0, stream: 'stdout', text: '', sealed: logEnv }] },
          },
          result: {
            logs: [{ sequence: 0, stream: 'stdout', text: 'hello\n', sealed: logEnv, e2ee: true }],
          },
        },
        {
          name: 'complete-task',
          input: { lease: 'lease-1', status: 'failed', error: 'boom' },
          request: {
            method: 'POST',
            path: `/api/v1/tasks/${TASK}/update`,
            body: { lease: 'lease-1', status: 'failed', errorSealed: errorEnv },
          },
          sealed: { errorSealed: { v: 1, error: 'boom' } },
          response: { status: 200, body: failed },
          result: failedOpen,
        },
        {
          name: 'download',
          input: { ...notes, key: fileKey },
          request: { method: 'GET', path: `/api/v1/files/${FILE}` },
          response: { status: 200, body: b64u.encode(bytes) },
          bytes: true,
          result: 'hello',
        },
        {
          name: 'offer-secret',
          input: offer,
          request: {
            method: 'POST',
            path: messages,
            headers: { 'Idempotency-Key': 'sealed-3' },
            body: {
              id: OFFER,
              kind: 'secret',
              sealed: offerEnv,
              digest: await e2ee.idempotencyDigest(runner.seed, offerPayload, 'sealed-3'),
              asks: false,
              attachments: [],
            },
          },
          sealed: { sealed: { v: 1, ...offerPayload } },
          response: { status: 201, body: offered },
          result: { ...offered, ...offerPayload, fields: [], e2ee: true },
        },
        {
          name: 'secret-receiver',
          request: { method: 'GET', path: `${messages}/${OFFER}/secret-receiver` },
          response: { status: 200, body: receiver },
          result: receiver,
        },
        {
          name: 'secret-receiver-forged',
          request: { method: 'GET', path: `${messages}/${OFFER}/secret-receiver` },
          response: { status: 200, body: forged },
          error: 'Bad receiver signature.',
        },
      ],
    };
  } finally {
    setTestHooks();
  }
}
