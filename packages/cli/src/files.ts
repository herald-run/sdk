import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Attachment, Herald } from '@herald-run/sdk';
const types: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip',
};
export const fileType = (path: string) =>
  types[extname(path).toLowerCase()] || 'application/octet-stream';
/** Streams a local file to Herald (≤100 MB); the type comes from its extension. */
export async function uploadPath(client: Herald, path: string): Promise<Attachment> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path} is not a file.`);
  if (info.size > 100_000_000) throw new Error('Files must be 100 MB or smaller.');
  return client.upload(basename(path), createReadStream(path), fileType(path), { size: info.size });
}
