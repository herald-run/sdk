import { bytesOf, fail } from './bytes';
// End-to-end tokens are `hdr_<auth>.<seed>.<fingerprint>`; only `hdr_<auth>` goes to the server.
export interface ParsedToken {
  auth: string;
  seed?: string;
  fingerprint?: string;
}
export function parseToken(token: string): ParsedToken {
  const parts = token.trim().split('.');
  if (parts.length === 1 && parts[0]) return { auth: parts[0] };
  if (parts.length !== 3 || !parts[0]) fail('Malformed token.');
  const [auth, seed, fingerprint] = parts;
  bytesOf(seed, 32);
  bytesOf(fingerprint, 16);
  return { auth, seed, fingerprint };
}
export function formatToken(auth: string, seed: string, fingerprint: string) {
  if (!auth || auth.includes('.')) fail('Malformed token.');
  const token = `${auth}.${seed}.${fingerprint}`;
  parseToken(token);
  return token;
}
