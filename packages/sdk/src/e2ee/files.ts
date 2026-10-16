import { b64u, bytesOf, concat, fail, type Bytes } from './bytes';
import { H } from './hash';
import { randomBytes } from './random';
// Sealed files: 7-byte random prefix, then AES-256-GCM chunks of up to 64 KiB plaintext.
// Chunk i uses nonce prefix || uint32_be(i) || last and AAD H("file").
const CHUNK = 65536;
const TAG = 16;
const PREFIX = 7;
export type FileSource = ReadableStream<Uint8Array> | Uint8Array;
export const fileKey = () => b64u.encode(randomBytes(32));
export const sealedSize = (size: number) =>
  PREFIX + size + TAG * Math.max(1, Math.ceil(size / CHUNK));
/** The plaintext size behind a sealed size, or undefined when no plaintext seals to it. */
export function plaintextSize(sealed: number): number | undefined {
  const body = sealed - PREFIX;
  const size = body - TAG * Math.max(1, Math.ceil(body / (CHUNK + TAG)));
  return Number.isSafeInteger(size) && size >= 0 && sealedSize(size) === sealed ? size : undefined;
}
const toStream = (source: FileSource): ReadableStream<Uint8Array> =>
  source instanceof Uint8Array
    ? new ReadableStream({ start: (c) => (c.enqueue(source), c.close()) })
    : source;
function nonce(prefix: Uint8Array, index: number, last: boolean) {
  if (index > 0xffffffff) fail('File too large.');
  const out = new Uint8Array(12);
  out.set(prefix);
  new DataView(out.buffer).setUint32(PREFIX, index);
  out[11] = last ? 1 : 0;
  return out;
}
async function cipher(key: Uint8Array | string, usage: 'encrypt' | 'decrypt') {
  const k = await crypto.subtle.importKey('raw', bytesOf(key, 32), 'AES-GCM', false, [usage]);
  const additionalData = await H('file');
  let index = 0;
  return async (prefix: Uint8Array, data: Uint8Array, last: boolean): Promise<Bytes> => {
    const params = { name: 'AES-GCM', iv: nonce(prefix, index++, last), additionalData };
    const run = usage === 'encrypt' ? crypto.subtle.encrypt : crypto.subtle.decrypt;
    try {
      return new Uint8Array(await run.call(crypto.subtle, params, k, concat(data)));
    } catch {
      return fail('File is corrupted or truncated.');
    }
  };
}
export function sealFile(key: Uint8Array | string, source: FileSource): ReadableStream<Bytes> {
  let run: Awaited<ReturnType<typeof cipher>>;
  let prefix: Bytes;
  let buffer: Bytes = new Uint8Array(0);
  return toStream(source).pipeThrough(
    new TransformStream<Uint8Array, Bytes>({
      async start(c) {
        run = await cipher(key, 'encrypt');
        prefix = randomBytes(PREFIX);
        c.enqueue(prefix.slice());
      },
      async transform(chunk, c) {
        buffer = concat(buffer, chunk);
        for (; buffer.length > CHUNK; buffer = buffer.slice(CHUNK))
          c.enqueue(await run(prefix, buffer.subarray(0, CHUNK), false));
      },
      async flush(c) {
        c.enqueue(await run(prefix, buffer, true));
      },
    }),
  );
}
/** Decrypts a sealed file. The stream errors on tampering, truncation, reordering or trailing data. */
export function openFile(key: Uint8Array | string, source: FileSource): ReadableStream<Bytes> {
  let run: Awaited<ReturnType<typeof cipher>>;
  let prefix: Bytes | undefined;
  let buffer: Bytes = new Uint8Array(0);
  const size = CHUNK + TAG;
  return toStream(source).pipeThrough(
    new TransformStream<Uint8Array, Bytes>({
      async start() {
        run = await cipher(key, 'decrypt');
      },
      async transform(chunk, c) {
        buffer = concat(buffer, chunk);
        if (!prefix && buffer.length >= PREFIX) {
          prefix = buffer.slice(0, PREFIX);
          buffer = buffer.slice(PREFIX);
        }
        for (; prefix && buffer.length > size; buffer = buffer.slice(size))
          c.enqueue(await run(prefix, buffer.subarray(0, size), false));
      },
      async flush(c) {
        if (!prefix || buffer.length < TAG) fail('File is corrupted or truncated.');
        c.enqueue(await run(prefix!, buffer, true));
      },
    }),
  );
}
