import type { Account, Destination, Message, TokenInfo } from '@herald-run/sdk';
// Human-readable output; `--json` prints the API records instead.
const value = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const pairs = (rows: [string, unknown][]) => {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  const width = Math.max(0, ...shown.map(([k]) => k.length));
  return shown.map(([k, v]) => `${k.padEnd(width)}  ${value(v)}`).join('\n');
};
const day = (iso?: string | null) => iso?.slice(0, 10);
export const messageLine = (m: Message) =>
  [m.id, m.status, m.direction === 'outbound' ? 'task' : m.kind || 'message', m.title].join('  ');
/** Answer values; stored fields show their path, uncollected secrets never a value. */
export function answer(m: Message, stored: Record<string, string> = {}) {
  const response = m.response;
  if (!response) return '';
  const values = { ...response.values } as Record<string, unknown>;
  for (const id of response.secretFields || []) values[id] = 'not collected';
  for (const [id, path] of Object.entries(stored)) values[id] = `stored ${path}`;
  return pairs([['action', response.actionId], ...Object.entries(values)]);
}
export function messageDetail(m: Message) {
  const logs = m.execution?.logs?.map((l) => l.text).join('') || '';
  return [
    pairs([
      ['id', m.id],
      ['title', m.title],
      ['status', m.status],
      ['kind', m.direction === 'outbound' ? 'task' : m.kind],
      ['from', m.sender],
      ['created', m.createdAt],
      ['expires', m.expiresAt],
      ['reply to', m.replyTo],
      ['thread', m.threadId],
      ['attachments', m.attachments?.map((a) => `${a.name} (${a.id})`).join(', ')],
      ['error', m.result?.error || m.execution?.error],
    ]),
    m.body,
    answer(m),
    logs && 'logs:\n' + logs.trimEnd(),
  ]
    .filter(Boolean)
    .join('\n\n');
}
export const destinationLine = (d: Destination) =>
  [d.id, d.key || '-', d.transport?.kind || 'pull', d.name].join('  ');
const person = (p: { name?: string; email: string }) =>
  p.name ? `${p.name} <${p.email}>` : p.email;
const usage = (a: Account): [string, unknown][] => [
  ['plan', a.unmetered ? `${a.plan} (unmetered)` : a.plan],
  ['used', a.used],
  ['reserved', a.reserved],
  ['credits', a.credits],
  ['storage', a.storage],
  ['devices', a.devices],
  ['resets', day(a.usageResetsAt || a.renewsAt)],
  ['channel', a.channel],
];
/** The token and its account holder, with the account's plan and usage when given. */
export const tokenSummary = (t: TokenInfo, a?: Account) =>
  pairs([
    ['token', `${t.name} (${t.id})`],
    ['scopes', t.scopes.join(', ')],
    ['account', person(t.account)],
    ['last used', t.lastUsedAt],
    ...(a ? usage(a) : []),
  ]);
/** For token callers the account record's `name` is the connection's name. */
export const accountSummary = (a: Account, holder: TokenInfo['account']) =>
  pairs([['account', person(holder)], ['connection', a.name], ...usage(a)]);
