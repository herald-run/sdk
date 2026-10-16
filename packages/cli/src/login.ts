import { hostname } from 'node:os';
import { Herald, version } from '@herald-run/sdk';
import { scopes, type Integration, type Scope } from '@herald-run/sdk/schema';
import * as e2ee from '@herald-run/sdk/e2ee';
/**
 * The local config: the token plus the connection it belongs to (older configs hold the token only).
 * End-to-end connections add their key seed and the account safety code they are pinned to.
 */
export type Saved = {
  token?: string;
  integrationId?: string;
  name?: string;
  seed?: string;
  fingerprint?: string;
};
export const encryptionLine = (fingerprint?: string) =>
  `End-to-end encryption: ${fingerprint ? `on (safety code ${fingerprint})` : 'off'}`;
export const userAgent = `herald-cli/${version}`;
export type LoginIo = {
  log: (line: string) => void;
  /** Interactive prompt; absent when stdin is not a terminal. */
  ask?: (question: string) => Promise<string>;
  /** Opens the approval page in a browser; absent with `--no-browser`. */
  open?: (url: string) => boolean;
  pause?: (ms: number) => Promise<void>;
};
/** One connection per device name. */
export const deviceName = () => `Herald CLI (${hostname()})`;
/** Everything an integration needs without asking. */
export const defaultScopes: Scope[] = [...scopes];
const known: string[] = [...scopes];
export function parseScopes(value?: string): Scope[] {
  if (!value?.trim()) return [...defaultScopes];
  if (value.trim() === 'all') return [...scopes];
  const chosen = [...new Set(value.split(',').map((s) => s.trim()))].filter(Boolean);
  const unknown = chosen.find((s) => !known.includes(s));
  if (unknown) throw new Error(`Unknown scope ${unknown}. Use all or: ${known.join(', ')}.`);
  return chosen as Scope[];
}
async function post(base: string, path: string, body: unknown, token?: string) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  const data = /json/.test(response.headers.get('Content-Type') || '')
    ? await response.json().catch(() => ({}))
    : (await response.body?.cancel(), {});
  return { response, data };
}
/** Browser-approved device login; reuses this device's connection when its token still matches. */
export async function login(
  base: string,
  options: { name?: string; scopes?: string },
  saved: Saved,
  io: LoginIo,
): Promise<{ saved: Saved; reused: boolean }> {
  const name = options.name || deviceName();
  const chosen = parseScopes(options.scopes);
  const pause = io.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const { response: started, data: device } = await post(base, '/api/auth/device/code', {
    client_id: 'herald-cli',
  });
  if (!started.ok) throw new Error(device.error_description || 'Could not start login.');
  // The fragment never reaches the server; an enrolled account's approval page certifies these keys.
  const keys = await e2ee.keySet();
  const page = `${device.verification_uri_complete || device.verification_uri}#k=${keys.signPub}.${keys.boxPub}`;
  const opened = /^https?:\/\//.test(page) && !!io.open?.(page);
  io.log(
    opened
      ? `Opened ${page} in your browser. Approve code ${device.user_code} there.`
      : `Open ${page} and approve code ${device.user_code}.`,
  );
  const deadline = Date.now() + device.expires_in * 1000;
  let delay = (device.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await pause(delay);
    const { response, data: result } = await post(base, '/api/auth/device/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: 'herald-cli',
    });
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') {
      delay += 5000;
      continue;
    }
    if (!response.ok) throw new Error(result.error_description || result.error || 'Login failed.');
    const human = new Herald({ url: base, apiKey: result.access_token, userAgent });
    try {
      const keyed = await certificate(human, keys, String(device.user_code));
      if (!keyed) io.log(encryptionLine());
      return await connect(human, name, chosen, saved, io, keyed);
    } finally {
      await post(base, '/api/auth/sign-out', {}, result.access_token).catch(() => {});
    }
  }
  throw new Error('The login request expired. Run herald login again.');
}
type Keyed = { seed: string; fingerprint: string; certificate: e2ee.Certificate };
/** For an enrolled account: the owner's certificate for this login's keys, checked locally. */
async function certificate(human: Herald, keys: e2ee.KeySet, userCode: string) {
  const directory = await human.keys();
  if (!directory.account) return undefined;
  const fingerprint = await e2ee.fingerprint(directory.account.statement.identity);
  const account = await e2ee.verifyAccount(directory.account, fingerprint);
  const cert = await human.deviceCertificate(userCode).catch(() => {
    throw new Error(
      'The approval did not certify this device for end-to-end encryption. Update Herald and run herald login again.',
    );
  });
  const checked = await e2ee.verifyCertificate(
    cert,
    account.identity,
    directory.account.statement.account,
  );
  if (checked.sign !== keys.signPub || checked.box !== keys.boxPub)
    throw new Error('The approval certified a different key. Run herald login again.');
  return { seed: keys.seed, fingerprint, certificate: cert };
}
async function connect(
  human: Herald,
  name: string,
  chosen: Scope[],
  saved: Saved,
  io: LoginIo,
  keyed?: Keyed,
) {
  const same = (await human.integrations()).filter((i) => i.name === name);
  const current = same.find((i) => i.id === saved.integrationId);
  const keys = keyed && { seed: keyed.seed, fingerprint: keyed.fingerprint };
  // A keyed login keeps its stored key only while that key's account is still the same one.
  const sameKeys = keyed ? saved.seed && saved.fingerprint === keyed.fingerprint : !saved.seed;
  if (
    saved.token &&
    current &&
    sameKeys &&
    current.scopes.length === chosen.length &&
    chosen.every((s) => current.scopes.includes(s))
  ) {
    const stored = { token: saved.token, integrationId: current.id, name };
    return {
      saved: keyed ? { ...stored, seed: saved.seed, fingerprint: saved.fingerprint } : stored,
      reused: true,
    };
  }
  const created = await human.createIntegration({
    name,
    scopes: chosen,
    ...(keyed ? { certificate: keyed.certificate } : {}),
  });
  if (same.length) await revokeOlder(human, name, same, io);
  return {
    saved: { token: created.token, integrationId: created.integration.id, name, ...keys },
    reused: false,
  };
}
/** Revoking breaks anything still using those tokens, so it needs an explicit yes in a terminal. */
async function revokeOlder(human: Herald, name: string, older: Integration[], io: LoginIo) {
  const kept = `${older.length} older ${name} connection(s) remain; revoke unused ones in Settings.`;
  if (!io.ask) return io.log(kept);
  // Revoking also removes a connection's destinations, so those that own any are never offered.
  const owners = new Set((await human.destinations()).map((d) => d.integrationId));
  const idle = older.filter((i) => !owners.has(i.id));
  const answer = idle.length
    ? await io.ask(
        `Revoke ${idle.length} older ${name} connection(s) without destinations? Anything still using their tokens stops working. [y/N]: `,
      )
    : '';
  if (!/^y(es)?$/i.test(answer.trim())) return io.log(kept);
  for (const old of idle)
    await human
      .deleteIntegration(old.id)
      .catch(() => io.log(`Could not revoke an older ${name} connection; revoke it in Settings.`));
}
