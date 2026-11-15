import {
  chatImageLimits,
  encodedWins,
  imagePlan,
  isAnimated,
  nameForType,
} from './schema/index.js';
export type ChatFile = { name: string; data: Uint8Array; type: string };
type Sharp = (
  data: Uint8Array,
  options?: { animated?: boolean },
) => {
  metadata(): Promise<{ width?: number; height?: number; pages?: number }>;
  rotate(): ReturnType<Sharp>;
  resize(
    width: number,
    height: number,
    options: { fit: 'inside'; withoutEnlargement: boolean },
  ): ReturnType<Sharp>;
  webp(options: { quality: number }): ReturnType<Sharp>;
  toBuffer(): Promise<Uint8Array>;
};
let loaded: Promise<Sharp | undefined> | undefined;
// An optional peer: a variable specifier keeps bundlers and types from requiring it.
const sharpModule = 'sharp';
const sharp = () =>
  (loaded ??= import(sharpModule).then(
    (m: { default: Sharp }) => m.default,
    () => undefined,
  ));
/**
 * Shrinks an image to WebP within `chatImageLimits.edge` when the optional `sharp` package is
 * installed (rotating it upright and dropping EXIF); otherwise, or when it gains nothing, as is.
 */
export async function shrinkImage(file: ChatFile, load = sharp): Promise<ChatFile> {
  if (!file.type.startsWith('image/') || isAnimated(file.data.subarray(0, 65536))) return file;
  const encode = await load();
  if (!encode) return file;
  try {
    const meta = await encode(file.data).metadata();
    // EXIF orientations 5 to 8 swap the sides; the long edge is the same either way.
    const { width = 0, height = 0 } = meta;
    const plan = imagePlan({ type: file.type, size: file.data.byteLength, width, height });
    if (!plan || (meta.pages ?? 1) > 1) return file;
    const data = await encode(file.data)
      .rotate()
      .resize(chatImageLimits.edge, chatImageLimits.edge, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: Math.round(chatImageLimits.quality * 100) })
      .toBuffer();
    if (!encodedWins(file.type, file.data.byteLength, data.byteLength, plan.resized)) return file;
    return { name: nameForType(file.name, 'image/webp'), data, type: 'image/webp' };
  } catch {
    return file;
  }
}
