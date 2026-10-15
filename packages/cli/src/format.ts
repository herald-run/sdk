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
export function answer(m: Message) {
  const response = m.response;
  if (!response) return '';
  return pairs([
    ['action', response.actionId],
    ...Object.entries(response.values || {}).map(([k, v]) => [k, v] as [string, unknown]),
  ]);
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
export const tokenSummary = (t: TokenInfo) =>
  pairs([
    ['token', `${t.name} (${t.id})`],
    ['scopes', t.scopes.join(', ')],
    ['account', t.account.name ? `${t.account.name} <${t.account.email}>` : t.account.email],
    ['last used', t.lastUsedAt],
  ]);
export const accountSummary = (a: Account) =>
  pairs([
    ['account', a.name ? `${a.name} <${a.email}>` : a.email],
    ['plan', a.unmetered ? `${a.plan} (unmetered)` : a.plan],
    ['used', a.used],
    ['reserved', a.reserved],
    ['credits', a.credits],
    ['storage', a.storage],
    ['devices', a.devices],
    ['resets', day(a.usageResetsAt || a.renewsAt)],
    ['channel', a.channel],
  ]);
