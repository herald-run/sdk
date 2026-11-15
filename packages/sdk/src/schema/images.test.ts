import { expect, it } from 'vitest';
import { encodedWins, fileTypeOf, imagePlan, isAnimated, nameForType } from './images';
const photo = { type: 'image/jpeg', size: 4_000_000, width: 4032, height: 3024 };
it('shrinks large images to the long edge and keeps small ones', () => {
  expect(imagePlan(photo)).toEqual({ width: 2048, height: 1536, resized: true });
  expect(imagePlan({ ...photo, type: 'image/png', width: 3024, height: 4032 })).toMatchObject({
    width: 1536,
    height: 2048,
  });
  const small = { type: 'image/png', size: 80_000, width: 800, height: 600 };
  // JPEG, PNG and WebP stills are always re-encoded, which drops EXIF and GPS.
  for (const type of ['image/png', 'image/jpeg', 'image/webp'])
    expect(imagePlan({ ...small, type })).toEqual({ width: 800, height: 600, resized: false });
  // AVIF and HEIC only when large.
  expect(imagePlan({ ...small, type: 'image/avif' })).toBeUndefined();
  expect(imagePlan({ ...small, type: 'image/heic', size: 2_000_000 })).toMatchObject({
    resized: false,
  });
  for (const type of ['image/gif', 'image/svg+xml', 'application/pdf'])
    expect(imagePlan({ ...photo, type })).toBeUndefined();
  expect(imagePlan({ ...photo, width: 0 })).toBeUndefined();
});
it('replaces the source even when re-encoding grew it, except AVIF and HEIC', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp'])
    expect(encodedWins(type, 100, 120, false)).toBe(true);
  expect(encodedWins('image/avif', 600_000, 700_000, false)).toBe(false);
  expect(encodedWins('image/avif', 600_000, 700_000, true)).toBe(true);
  expect(encodedWins('image/heic', 600_000, 300_000, false)).toBe(true);
});
it('spots animated PNG and WebP', () => {
  const chunk = (name: string, size = 0) => {
    const out = new Uint8Array(12 + size);
    new DataView(out.buffer).setUint32(0, size);
    out.set(
      [...name].map((c) => c.charCodeAt(0)),
      4,
    );
    return out;
  };
  const png = (...chunks: Uint8Array[]) =>
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...chunks.flatMap((c) => [...c])]);
  expect(isAnimated(png(chunk('IHDR', 13), chunk('acTL', 8), chunk('IDAT')))).toBe(true);
  expect(isAnimated(png(chunk('IHDR', 13), chunk('IDAT'), chunk('acTL', 8)))).toBe(false);
  const webp = (flags: number) => {
    const out = new Uint8Array(30);
    out.set([...'RIFF....WEBPVP8X'].map((c) => c.charCodeAt(0)));
    out[20] = flags;
    return out;
  };
  expect(isAnimated(webp(2))).toBe(true);
  expect(isAnimated(webp(16))).toBe(false);
  expect(isAnimated(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false);
});
it('names types from extensions and back', () => {
  expect(fileTypeOf('IMG_1.JPG')).toBe('image/jpeg');
  expect(fileTypeOf('notes')).toBe('application/octet-stream');
  expect(nameForType('IMG_1.HEIC', 'image/webp')).toBe('IMG_1.webp');
  expect(nameForType('shot', 'image/jpeg')).toBe('shot.jpg');
});
