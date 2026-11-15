/** Chat attachments per message; images above `keepBytes` or `edge` are shrunk by senders. */
export const chatFileLimits = { count: 10 };
export const chatImageLimits = { edge: 2048, quality: 0.8, keepBytes: 500_000 };
const types: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  mp4: 'video/mp4',
  webm: 'video/webm',
};
/** A file's type from its extension; `application/octet-stream` when unknown. */
export const fileTypeOf = (name: string) =>
  types[/\.([^./]+)$/.exec(name)?.[1].toLowerCase() ?? ''] ?? 'application/octet-stream';
/** Re-encodable stills; GIF and SVG pass through. */
const stills = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic']);
/** An animated PNG or WebP, from the file's first bytes (64 KB is enough). */
export function isAnimated(head: Uint8Array) {
  const tag = (at: number) => String.fromCharCode(...head.subarray(at, at + 4));
  if (tag(12) === 'VP8X' && tag(8) === 'WEBP') return (head[20] & 2) !== 0;
  if (tag(0) !== '\x89PNG') return false;
  for (let at = 8; at + 8 <= head.length;) {
    const size = new DataView(head.buffer, head.byteOffset + at).getUint32(0);
    const name = tag(at + 4);
    if (name === 'acTL') return true;
    if (name === 'IDAT') return false;
    at += size + 12;
  }
  return false;
}
/**
 * The size to re-encode an image at, or undefined to send it as is: GIFs, SVGs and animations
 * pass, as do small images within `edge` (JPEGs are always re-encoded, which drops EXIF).
 */
export function imagePlan(image: { type: string; size: number; width: number; height: number }) {
  if (!stills.has(image.type) || !(image.width > 0 && image.height > 0)) return undefined;
  const scale = Math.min(1, chatImageLimits.edge / Math.max(image.width, image.height));
  if (scale === 1 && image.type !== 'image/jpeg' && image.size <= chatImageLimits.keepBytes)
    return undefined;
  const width = Math.max(1, Math.round(image.width * scale));
  return { width, height: Math.max(1, Math.round(image.height * scale)), resized: scale < 1 };
}
/** Whether a re-encoded image replaces its source: not when it only grew (JPEGs always do). */
export const encodedWins = (type: string, before: number, after: number, resized: boolean) =>
  resized || type === 'image/jpeg' || after < before;
/** The file name for a new type: `photo.HEIC` as WebP is `photo.webp`. */
export const nameForType = (name: string, type: string) =>
  name.replace(/(\.[^./]*)?$/, '.' + (type.split('/')[1] === 'jpeg' ? 'jpg' : type.split('/')[1]));
