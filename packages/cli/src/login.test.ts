import { afterEach, expect, it, vi } from 'vitest';
import { scopes } from '@herald-run/sdk/schema';
import * as e2ee from '@herald-run/sdk/e2ee';
import { defaultScopes, login, parseScopes } from './login';
afterEach(() => vi.restoreAllMocks());
type Server = {
  integrations: Array<{ id: string; name: string; scopes: string[] }>;
  destinations?: Array<{ id: string; integrationId: string }>;
  keys?: unknown;
  certificate?: () => Promise<unknown>;
};
function server(state: Server) {
  const calls: string[] = [];
  let polls = 0;
  const created: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname,
      method = init?.method || 'GET';
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === '/api/auth/device/code')
      return Response.json({
        device_code: 'd',
        user_code: 'U',
        verification_uri: 'https://herald.test/device',
        expires_in: 60,
        interval: 1,
      });
    if (path === '/api/auth/device/token')
      return polls++
        ? Response.json({ access_token: 'human' })
        : Response.json({ error: 'authorization_pending' }, { status: 400 });
    if (path === '/api/v1/integrations' && method === 'GET')
      return Response.json(state.integrations);
    if (path === '/api/v1/integrations') {
      created.push(body);
      return Response.json(
        { token: 'hdr_new', integration: { id: 'new', ...body } },
        { status: 201 },
      );
    }
    if (path === '/api/v1/destinations') return Response.json(state.destinations || []);
    if (path === '/api/v1/keys') return Response.json(state.keys || { account: null });
    if (path === '/api/v1/keys/device-code/U') return Response.json(await state.certificate!());
    return Response.json({ ok: true });
  });
  return { calls, created };
}
const io = () => ({ log: vi.fn(), pause: async () => {} });
const device = 'Herald CLI (laptop)';
it('reuses the stored token of this device connection without creating another', async () => {
  const { calls, created } = server({
    integrations: [{ id: 'old', name: device, scopes: [...scopes] }],
  });
  const result = await login(
    'https://herald.test',
    { name: device },
    { token: 'hdr_old', integrationId: 'old' },
    io(),
  );
  expect(result).toEqual({
    reused: true,
    saved: { token: 'hdr_old', integrationId: 'old', name: device },
  });
  expect(created).toEqual([]);
  expect(calls).toContain('POST /api/auth/sign-out');
});
it.each([
  ['without a terminal', undefined, []],
  ['on a declined prompt', '', []],
  [
    'on an explicit yes, sparing ones with destinations',
    'y',
    ['DELETE /api/v1/integrations/stale'],
  ],
])('revokes older same-name connections only %s', async (_, reply, deletes) => {
  const { calls, created } = server({
    integrations: [
      { id: 'stale', name: device, scopes: [...scopes] },
      { id: 'busy', name: device, scopes: [...scopes] },
      { id: 'other', name: 'Other device', scopes: [...scopes] },
    ],
    destinations: [{ id: 'd', integrationId: 'busy' }],
  });
  const log = io();
  const ask = reply === undefined ? undefined : vi.fn(async () => reply);
  const result = await login(
    'https://herald.test',
    { name: device, scopes: 'messages:send,messages:read' },
    { token: 'hdr_stale', integrationId: 'stale' },
    { ...log, ask },
  );
  expect(result.saved).toEqual({ token: 'hdr_new', integrationId: 'new', name: device });
  expect(created).toEqual([{ name: device, scopes: ['messages:send', 'messages:read'] }]);
  expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual(deletes);
  if (ask) expect(ask).toHaveBeenCalledWith(expect.stringContaining('Revoke 1 older'));
  if (!deletes.length) expect(log.log).toHaveBeenCalledWith(expect.stringContaining('2 older'));
});
it('requests the default scopes without asking and rejects unknown scopes before login', async () => {
  const { created } = server({ integrations: [] });
  const ask = vi.fn(async () => 'files:write');
  const open = vi.fn(() => true);
  const log = io();
  await login('https://herald.test', {}, {}, { ...log, ask, open });
  expect(ask).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith(
    expect.stringMatching(/^https:\/\/herald\.test\/device#k=[\w-]+\.[\w-]+$/),
  );
  expect(log.log).toHaveBeenCalledWith(
    expect.stringContaining('Opened https://herald.test/device'),
  );
  expect(created).toEqual([
    {
      name: expect.stringMatching(/^Herald CLI \(/),
      scopes: expect.arrayContaining(['events:read', 'files:write']),
    },
  ]);
  expect(parseScopes('')).toEqual(defaultScopes);
  expect(parseScopes('all')).toEqual([...scopes]);
  await expect(login('https://herald.test', { scopes: 'root' }, {}, io())).rejects.toThrow(
    'Unknown scope root',
  );
});
it('prefers the complete verification link and never opens other schemes', async () => {
  server({ integrations: [] });
  vi.mocked(globalThis.fetch).mockImplementationOnce(async () =>
    Response.json({
      device_code: 'd',
      user_code: 'U',
      verification_uri: 'https://herald.test/device',
      verification_uri_complete: 'https://herald.test/device?user_code=U',
      expires_in: 60,
      interval: 1,
    }),
  );
  const open = vi.fn(() => true);
  await login('https://herald.test', {}, {}, { ...io(), open });
  expect(open).toHaveBeenCalledWith(
    expect.stringMatching(/^https:\/\/herald\.test\/device\?user_code=U#k=[\w-]+\.[\w-]+$/),
  );
  vi.mocked(globalThis.fetch).mockImplementationOnce(async () =>
    Response.json({
      device_code: 'd',
      user_code: 'U',
      verification_uri: 'file:///etc/passwd',
      expires_in: 60,
    }),
  );
  open.mockClear();
  await login('https://herald.test', {}, {}, { ...io(), open });
  expect(open).not.toHaveBeenCalled();
});
it('certifies the key from the approval link on enrolled accounts', async () => {
  const keyring = e2ee.createKeyring('acct');
  const account = await e2ee.accountStatement(keyring);
  let link = '';
  const key = () => link.split('#k=')[1].split('.');
  const open = vi.fn((url: string) => !!(link = url));
  const certify = (sign: string, box: string) => e2ee.certify(keyring, { sign, box });
  const { created } = server({
    integrations: [],
    keys: { account, certificates: [] },
    certificate: () => certify(key()[0], key()[1]),
  });
  const { saved } = await login('https://herald.test', {}, {}, { ...io(), open });
  const fingerprint = await e2ee.fingerprint(account.statement.identity);
  expect(saved).toMatchObject({ token: 'hdr_new', fingerprint });
  expect((await e2ee.keySet(saved.seed)).signPub).toBe(key()[0]);
  const [sign, box] = key();
  const certificate = expect.objectContaining({
    certificate: expect.objectContaining({ sign, box }),
  });
  expect(created).toEqual([expect.objectContaining({ certificate })]);
  server({
    integrations: [],
    keys: { account, certificates: [] },
    certificate: async () => certify(key()[1], key()[0]),
  });
  await expect(login('https://herald.test', {}, {}, { ...io(), open })).rejects.toThrow(
    'different key',
  );
});
