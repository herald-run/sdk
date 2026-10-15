export type UploadData = Uint8Array | Blob | AsyncIterable<Uint8Array>;
/** Bytes per pull: each pull is progress, so slow links reset the idle timer often. */
const SLICE = 1 << 14;
/**
 * A request body that aborts `controller` when fetch pulls no bytes for `idleMs`, and keeps that
 * deadline after the last chunk until `done()` is called (once response headers arrive).
 */
export function idleBody(data: UploadData, idleMs: number, controller: AbortController) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error(`Upload stalled for ${idleMs / 1000} s.`)),
      idleMs,
    );
  };
  const source: AsyncIterable<Uint8Array> = slices(
    data instanceof Uint8Array
      ? [data]
      : data instanceof Blob
        ? (data.stream() as unknown as AsyncIterable<Uint8Array>)
        : data,
  );
  const iterator = source[Symbol.asyncIterator]();
  touch();
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      const next = await iterator.next();
      touch();
      if (next.done) stream.close();
      else stream.enqueue(next.value);
    },
    cancel() {
      // Not awaited: a stalled source may never settle.
      iterator.return?.()?.catch(() => {});
    },
  });
  return { body, done: () => clearTimeout(timer) };
}
async function* slices(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  for await (const chunk of source)
    for (let i = 0; i < chunk.byteLength; i += SLICE) yield chunk.subarray(i, i + SLICE);
}
