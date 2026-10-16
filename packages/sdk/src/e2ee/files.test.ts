import { expect, it } from 'vitest';
import { fileKey, openFile, sealedSize, sealFile } from './index';
const CHUNK = 65536;
const read = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer());
const pattern = (size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 7) % 251);
/** A stream that delivers `bytes` in uneven pieces. */
const pieces = (bytes: Uint8Array, size = 1000) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    },
  });
it('round trips files of every chunk shape, from bytes and streams', async () => {
  const key = fileKey();
  for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 2 * CHUNK + 5]) {
    const plain = pattern(size);
    const sealed = await read(sealFile(key, pieces(plain, 4093)));
    expect(sealed.length, String(size)).toBe(sealedSize(size));
    expect(await read(openFile(key, sealed))).toEqual(plain);
    expect(await read(openFile(key, pieces(sealed, 777)))).toEqual(plain);
  }
  expect(sealedSize(0)).toBe(23);
  expect(sealedSize(CHUNK)).toBe(7 + CHUNK + 16);
  expect(sealedSize(CHUNK + 1)).toBe(7 + CHUNK + 1 + 32);
});
it('rejects tampering, truncation, reordering, extension and the wrong key', async () => {
  const key = fileKey();
  const sealed = await read(sealFile(key, pattern(2 * CHUNK + 5)));
  const size = CHUNK + 16;
  const [prefix, a, b, c] = [
    sealed.slice(0, 7),
    sealed.slice(7, 7 + size),
    sealed.slice(7 + size, 7 + 2 * size),
    sealed.slice(7 + 2 * size),
  ];
  const join = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
  const flipped = sealed.slice();
  flipped[100] ^= 1;
  const bad = {
    tampered: flipped,
    'wrong prefix': join(Uint8Array.of(prefix[0] ^ 1), prefix.slice(1), a, b, c),
    'dropped last chunk': join(prefix, a, b),
    'dropped middle chunk': join(prefix, a, c),
    reordered: join(prefix, b, a, c),
    'trailing byte': join(sealed, Uint8Array.of(0)),
    'trailing chunk': join(sealed, c),
    'cut tag': sealed.slice(0, -1),
    'prefix only': prefix,
    empty: new Uint8Array(0),
  };
  for (const [name, bytes] of Object.entries(bad))
    await expect(read(openFile(key, bytes)), name).rejects.toThrow(/corrupted or truncated/);
  await expect(read(openFile(fileKey(), sealed))).rejects.toThrow(/corrupted/);
});
