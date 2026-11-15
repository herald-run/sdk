import { expect, it, vi } from 'vitest';
import { shrinkImage } from './images';
const file = { name: 'a.jpg', type: 'image/jpeg', data: new Uint8Array(10) };
it('sends images as they are without sharp', async () => {
  expect(await shrinkImage(file, async () => undefined)).toBe(file);
});
it('re-encodes through sharp to WebP within the edge', async () => {
  const resize = vi.fn();
  const pipe = {
    metadata: async () => ({ width: 4000, height: 3000 }),
    rotate: () => pipe,
    resize: (...args: unknown[]) => (resize(...args), pipe),
    webp: () => pipe,
    toBuffer: async () => new Uint8Array(4),
  };
  const out = await shrinkImage(file, async () => () => pipe);
  expect(out).toMatchObject({ name: 'a.webp', type: 'image/webp' });
  expect(resize).toHaveBeenCalledWith(2048, 2048, { fit: 'inside', withoutEnlargement: true });
  const gif = { ...file, name: 'a.gif', type: 'image/gif' };
  expect(await shrinkImage(gif, async () => () => pipe)).toBe(gif);
});
