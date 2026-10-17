import { mkdir, open, rm, unlink, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { setTimeout as pause } from 'node:timers/promises';
import { Herald, type FileAttachment, type Message, type MessageRequest } from '@herald-run/sdk';
import { seal } from '@herald-run/sdk/crypto';
import { publicKeySchema, type Field } from '@herald-run/sdk/schema';

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
/** A secret or file field's answer, written to a new private path. */
export type Output = { field: string; path: string };
export const isSecret = (f: Field) => f.type === 'secret' || !!f.secret;
/** A file name safe to create inside an output directory. */
const safeName = (name: string, index: number, taken: Set<string>) => {
  let safe = [...name]
    .filter((c) => c >= ' ' && c !== '\x7f')
    .join('')
    .replace(/[/\\]/g, '_')
    .trim();
  if (['', '.', '..'].includes(safe)) safe = `file-${index + 1}`;
  if (taken.has(safe)) safe = `${index + 1}-${safe}`;
  taken.add(safe);
  return safe;
};
type Upload = string | FileAttachment;
async function save(client: Herald, file: Upload, output: FileHandle) {
  const download = await client.download(file);
  for await (const chunk of Readable.fromWeb(download.body as ReadableStream))
    await output.write(chunk);
  await output.sync();
}
/**
 * Opens every output with `wx` (0600) before `start` sends or names the request, waits for the
 * answer and writes each field to its path: text for secrets, a file for one upload, a 0700
 * directory for several. Any failure deletes the outputs and cancels the request.
 */
export async function collect(
  client: Herald,
  outputs: Output[],
  start: () => Promise<string>,
  timeout: number,
  failure: string,
): Promise<{ message: Message; stored: Record<string, string> }> {
  const handles = new Map<string, FileHandle>();
  const made: string[] = [];
  let complete = false;
  let id: string | undefined;
  try {
    for (const { field, path } of outputs) {
      const handle = await open(path, 'wx', 0o600);
      made.push(path);
      handles.set(field, handle);
      await handle.chmod(0o600);
    }
    id = await start();
    const message = await client.wait(id, { waitTimeout: timeout });
    const response = message.response;
    if (message.status !== 'answered' || !response) return { message, stored: {} };
    const fields = outputs.map((o) => {
      const field = message.fields.find((f) => f.id === o.field);
      if (!field || !(field.type === 'secret' || field.type === 'file')) throw new Error(failure);
      return field;
    });
    // Apps without secret files answer with an ordinary attachment, kept in history: refuse it.
    for (const f of fields.filter(isSecret))
      if (f.id in response.values || (f.required && !response.secretFields.includes(f.id)))
        throw new Error(failure);
    const revealed = fields.some((f) => isSecret(f) && response.secretFields.includes(f.id))
      ? await client.revealSecrets(id)
      : {};
    const stored: Record<string, string> = {};
    for (const [index, f] of fields.entries()) {
      const { path } = outputs[index];
      const output = handles.get(f.id)!;
      const value = isSecret(f) ? revealed[f.id] : response.values[f.id];
      if (value === undefined || value === null || (Array.isArray(value) && !value.length)) {
        if (f.required) throw new Error(failure);
        await output.close();
        handles.delete(f.id);
        await unlink(path);
        continue;
      }
      if (f.type === 'secret') {
        if (typeof value !== 'string') throw new Error(failure);
        await output.writeFile(value, 'utf8');
        await output.sync();
      } else {
        if (!Array.isArray(value) || value.length > (f.maxItems ?? 10)) throw new Error(failure);
        const name = (file: Upload) =>
          typeof file === 'string'
            ? message.attachments.find((a) => a.id === file)?.name || ''
            : file.name;
        if (value.length === 1) await save(client, value[0], output);
        else {
          await output.close();
          handles.delete(f.id);
          await unlink(path);
          await mkdir(path, { mode: 0o700 });
          const taken = new Set<string>();
          for (const [n, file] of value.entries()) {
            const handle = await open(join(path, safeName(name(file), n, taken)), 'wx', 0o600);
            try {
              await save(client, file, handle);
            } finally {
              await handle.close();
            }
          }
        }
      }
      stored[f.id] = path;
    }
    complete = true;
    return { message, stored };
  } finally {
    for (const handle of handles.values()) await handle.close().catch(() => {});
    if (!complete) {
      for (const path of made) await rm(path, { recursive: true, force: true }).catch(() => {});
      if (id) await client.cancel(id).catch(() => {});
    }
  }
}
/** Sends `input` and collects one field into `path`; throws `failure` unless it was stored. */
async function requestOne(
  client: Herald,
  path: string,
  input: MessageRequest,
  options: Options,
  failure: string,
) {
  checkOptions(options, failure);
  const field = input.fields![0].id;
  const send = async () =>
    (await client.send({ ...input, expiresIn: Math.min(options.deadline, options.timeout) })).id;
  const { message, stored } = await collect(
    client,
    [{ field, path }],
    send,
    options.timeout,
    failure,
  );
  if (!stored[field]) throw new Error(failure);
  return { id: message.id, status: 'stored' };
}
export async function requestSecret(client: Herald, path: string, options: Options) {
  // The value arrives sealed to this connection's key.
  const input: MessageRequest = {
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
  };
  return requestOne(client, path, input, options, secretFailure);
}
/** Requests one file sealed to this connection alone and writes it to a new 0600 file. */
export async function requestFile(client: Herald, path: string, options: Options) {
  const input: MessageRequest = {
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
  };
  return requestOne(client, path, input, options, fileFailure);
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
