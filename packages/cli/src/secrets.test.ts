import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { build } from 'esbuild';
import { createKeys, unseal } from '@herald-run/sdk/crypto';
import type { Envelope, Message } from '@herald-run/sdk/schema';
import * as sealed from '../../sdk/fixtures/sealed';
const execute = promisify(execFile);
const canary = 'test-only-secret-with-exact-spacing\n  second line\n';
let folder: string, base: string, bundle: string;
let incoming: string[] = [],
  delivered: Envelope | undefined,
  failure = false;
let receiver: Awaited<ReturnType<typeof createKeys>>;
let request: Message;
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  incoming.push(body);
  const input = body ? JSON.parse(body) : undefined;
  res.setHeader('Content-Type', 'application/json');
  if (failure) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: canary }));
    return;
  }
  let result: unknown = {};
  if (req.url === '/api/v1/keys') result = sealed.directory;
  else if (req.url === '/api/v1/messages' && req.method === 'POST')
    result = request = sealed.stored(input);
  else if (req.url === `/api/v1/messages/${request?.id}`)
    result = await sealed.sealedAnswer(request, {}, { secretFields: ['secret'] });
  else if (req.url?.endsWith('/secrets'))
    result = { secret: await sealed.sealedSecret(request.id, 'secret', canary) };
  else if (req.url?.endsWith('/secret-receiver'))
    result = await sealed.signedReceiver(request.id, receiver.publicKey);
  else if (req.url?.endsWith('/secret-delivery')) delivered = input.envelope;
  res.end(JSON.stringify(result));
});
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'herald-secret-test-'));
  bundle = join(folder, 'herald.mjs');
  await build({
    entryPoints: ['packages/cli/src/index.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  receiver = await createKeys();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(folder, { recursive: true, force: true });
});
const cli = (...args: string[]) =>
  execute(process.execPath, [bundle, ...args], {
    env: { ...process.env, HERALD_URL: base, HERALD_API_KEY: sealed.token },
  });
it('requests directly into a new owner-only file without stdout/stderr/history plaintext', async () => {
  incoming = [];
  const path = join(folder, 'received');
  const parent = crypto.randomUUID();
  const result = await cli('request-secret', '--json', '--out', path, '--reply-to', parent);
  expect(JSON.parse(incoming.find(Boolean)!).replyTo).toBe(parent);
  expect(await readFile(path, 'utf8')).toBe(canary);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(result.stdout).status).toBe('stored');
  expect(result.stdout + result.stderr + incoming.join('')).not.toContain(canary.split('\n')[0]);
});
it('sends a file exactly as encrypted ciphertext without printing its value', async () => {
  incoming = [];
  const path = join(folder, 'source');
  await writeFile(path, canary, { mode: 0o600 });
  const parent = crypto.randomUUID();
  const result = await cli('send-secret', '--json', '--input', path, '--reply-to', parent);
  expect(JSON.parse(incoming.find(Boolean)!).replyTo).toBe(parent);
  expect(await unseal(delivered!, receiver.privateKey)).toBe(canary);
  expect(JSON.parse(result.stdout).status).toBe('delivered');
  expect(result.stdout + result.stderr + incoming.join('')).not.toContain(canary.split('\n')[0]);
});
it('does not overwrite existing files or follow output symlinks', async () => {
  const target = join(folder, 'existing');
  await writeFile(target, 'keep');
  const link = join(folder, 'link');
  await symlink(target, link);
  for (const path of [target, link]) {
    await expect(cli('request-secret', '--out', path)).rejects.toMatchObject({ code: 1 });
    expect(await readFile(target, 'utf8')).toBe('keep');
  }
});
it('redacts errors from the server and rejects value arguments without echoing them', async () => {
  failure = true;
  const path = join(folder, 'failed-output');
  try {
    await cli('request-secret', '--out', path);
    throw new Error('Expected failure');
  } catch (error) {
    const result = error as { stdout: string; stderr: string };
    expect(result.stdout + result.stderr).not.toContain(canary.split('\n')[0]);
    expect(result.stderr).toContain('Secret transfer failed');
  }
  expect(await stat(path).catch(() => null)).toBeNull();
  failure = false;
  await expect(cli('send-secret', '--secret-value', canary)).rejects.toMatchObject({ code: 2 });
  try {
    await cli('send-secret', '--secret-value', canary);
  } catch (error) {
    expect((error as { stderr: string }).stderr).not.toContain(canary.split('\n')[0]);
  }
});

it('does not echo malformed credential-bearing server URLs during secret commands', async () => {
  try {
    await execute(process.execPath, [bundle, 'send-secret', '--input', 'unused'], {
      env: {
        ...process.env,
        HERALD_URL: 'invalid-test-only-secret-url',
        HERALD_API_KEY: 'test-only',
      },
    });
    throw new Error('Expected failure');
  } catch (error) {
    const result = error as { stdout: string; stderr: string };
    expect(result.stderr).toContain('Secret transfer failed');
    expect(result.stdout + result.stderr).not.toContain('invalid-test-only-secret-url');
  }
});
