import { open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { setTimeout as pause } from 'node:timers/promises';
import { Herald } from '@herald-run/sdk';
import { seal } from '@herald-run/sdk/crypto';
import { publicKeySchema } from '@herald-run/sdk/schema';

type Options = {
  replyTo?: string;
  title?: string;
  body?: string;
  label?: string;
  deadline: number;
  timeout: number;
};
// Only this fixed message reaches stderr: server errors may contain untrusted values.
export const secretFailure =
  'Secret transfer failed. Check authentication, file access, and the request deadline. Secret output files must not already exist.';
export const fileFailure =
  'File transfer failed. Check authentication, file access, and the request deadline. Output files must not already exist.';
function checkOptions(options: Options, failure = secretFailure) {
  if (![options.deadline, options.timeout].every((n) => Number.isFinite(n) && n > 0 && n <= 86400))
    throw new Error(failure);
}
export async function requestSecret(client: Herald, path: string, options: Options) {
  checkOptions(options);
  const output = await open(path, 'wx', 0o600);
  let complete = false;
  let messageId: string | undefined;
  try {
    await output.chmod(0o600);
    // The value arrives sealed to this connection's key.
    const message = await client.send({
      title: options.title || 'Secret Requested',
      replyTo: options.replyTo,
      kind: 'form',
      fields: [
        {
          id: 'secret',
          label: options.label || 'Secret',
          type: 'secret',
          required: true,
          maxLength: 16000,
        },
      ],
      expiresIn: Math.min(options.deadline, options.timeout),
    });
    messageId = message.id;
    const answer = await client.wait(message.id, { waitTimeout: options.timeout });
    if (answer.status !== 'answered') throw new Error(secretFailure);
    const value = (await client.revealSecrets(message.id)).secret;
    if (typeof value !== 'string') throw new Error(secretFailure);
    await output.writeFile(value, 'utf8');
    await output.sync();
    complete = true;
    return { id: message.id, status: 'stored' };
  } finally {
    await output.close();
    if (!complete) {
      await unlink(path).catch(() => {});
      if (messageId) await client.cancel(messageId).catch(() => {});
    }
  }
}
/** Requests one file sealed to this connection alone and writes it to a new 0600 file. */
export async function requestFile(client: Herald, path: string, options: Options) {
  checkOptions(options, fileFailure);
  const output = await open(path, 'wx', 0o600);
  let complete = false;
  let messageId: string | undefined;
  try {
    await output.chmod(0o600);
    const message = await client.send({
      title: options.title || 'File Requested',
      body: options.body,
      replyTo: options.replyTo,
      kind: 'form',
      fields: [
        {
          id: 'file',
          label: options.label || 'File',
          type: 'file',
          secret: true,
          required: true,
          minItems: 1,
          maxItems: 1,
        },
      ],
      expiresIn: Math.min(options.deadline, options.timeout),
    });
    messageId = message.id;
    const answer = await client.wait(message.id, { waitTimeout: options.timeout });
    if (answer.status !== 'answered') throw new Error(fileFailure);
    // Apps without secret files answer with an ordinary attachment.
    const ids = answer.response?.values.file;
    const files = answer.response?.secretFields.includes('file')
      ? (await client.revealSecrets(message.id)).file
      : answer.attachments.filter((file) => Array.isArray(ids) && ids.includes(file.id));
    if (!Array.isArray(files) || files.length !== 1) throw new Error(fileFailure);
    const file = await client.download(files[0]);
    for await (const chunk of Readable.fromWeb(file.body as ReadableStream))
      await output.write(chunk);
    await output.sync();
    complete = true;
    return { id: message.id, status: 'stored' };
  } finally {
    await output.close();
    if (!complete) {
      await unlink(path).catch(() => {});
      if (messageId) await client.cancel(messageId).catch(() => {});
    }
  }
}
export async function sendSecret(client: Herald, path: string, options: Options) {
  checkOptions(options);
  // No argv/stdin secret values; bounded regular-file reads also reject pipes/devices.
  const input = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let value: string;
  try {
    const info = await input.stat();
    if (!info.isFile() || info.size < 1 || info.size > 16000) throw new Error(secretFailure);
    const data = Buffer.alloc(16001);
    try {
      let size = 0;
      while (size < data.length) {
        const { bytesRead } = await input.read(data, size, data.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (!size || size > 16000) throw new Error(secretFailure);
      value = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, size));
    } finally {
      data.fill(0);
    }
  } finally {
    await input.close();
  }
  return sendSecretValue(client, value, options);
}
export async function sendSecretValue(client: Herald, value: string, options: Options) {
  checkOptions(options);
  const size = Buffer.byteLength(value, 'utf8');
  if (!size || size > 16000) throw new Error(secretFailure);
  const message = await client.send({
    title: options.title || 'Secret Available',
    body: options.body,
    replyTo: options.replyTo,
    kind: 'secret',
    expiresIn: Math.min(options.deadline, options.timeout),
  });
  let complete = false;
  try {
    const signal = AbortSignal.timeout(options.timeout * 1000);
    while (!signal.aborted) {
      const receiver = await client.secretReceiver(message.id, { signal });
      if (receiver.received) {
        complete = true;
        break;
      }
      if (receiver.claimId && receiver.publicKey) {
        const envelope = await seal(value, publicKeySchema.parse(receiver.publicKey));
        await client.deliverSecret(message.id, { claimId: receiver.claimId, envelope }, { signal });
        complete = true;
        break;
      }
      await pause(1500, undefined, { signal });
    }
    if (!complete) throw new Error(secretFailure);
    return { id: message.id, status: 'delivered' };
  } finally {
    if (!complete) await client.cancel(message.id).catch(() => {});
  }
}
