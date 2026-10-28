import type { Account, Destination, Message, TokenInfo, WorkspaceInfo } from '@herald-run/sdk';
// Human-readable output; `--json` prints the API records instead.
// Choice lists read as "A, B", including an Other answer; PDF comments one per line.
const percent = (n: number) => `${Math.round(n * 100)}%`;
const comment = (c: Record<string, unknown>) =>
  [
    `p.${c.page}`,
    `${percent(c.x as number)},${percent(c.y as number)}`,
    ...(typeof c.w === 'number' && typeof c.h === 'number'
      ? [`${percent(c.w)}x${percent(c.h)}`]
      : []),
    String(c.text).replace(/\s+/g, ' ').trim(),
  ].join('  ');
const isComment = (x: unknown) =>
  typeof x === 'object' &&
  x !== null &&
  typeof (x as { page?: unknown }).page === 'number' &&
  typeof (x as { text?: unknown }).text === 'string';
const value = (v: unknown) =>
  typeof v === 'string'
    ? v
    : Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')
      ? v.join(', ')
      : Array.isArray(v) && v.length && v.every(isComment)
        ? v.map(comment).join('\n')
        : JSON.stringify(v);
const pairs = (rows: [string, unknown][]) => {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  const width = Math.max(0, ...shown.map(([k]) => k.length));
  // Only lists span lines (comments); continuation lines align under the first.
  const text = (v: unknown) =>
    Array.isArray(v) ? value(v).replaceAll('\n', '\n' + ' '.repeat(width + 2)) : value(v);
  return shown.map(([k, v]) => `${k.padEnd(width)}  ${text(v)}`).join('\n');
};
const day = (iso?: string | null) => iso?.slice(0, 10);
export const messageLine = (m: Message) =>
  [m.id, m.status, m.direction === 'outbound' ? 'task' : m.kind || 'message', m.title].join('  ');
/** Answer values; stored fields show their path, uncollected secrets never a value. */
export function answer(m: Message, stored: Record<string, string> = {}) {
  const response = m.response;
  if (!response) return '';
  const values = { ...response.values } as Record<string, unknown>;
  for (const f of m.fields || [])
    if (
      f.type === 'annotations' &&
      Array.isArray(values[f.id]) &&
      !(values[f.id] as unknown[]).length
    )
      values[f.id] = 'none';
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
      ['team', m.team],
      ['assignee', m.assignee],
      ['answered by', m.answeredBy],
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
/** The verified team workspace and the teams this connection may address, its default first. */
export const workspaceSummary = (w: WorkspaceInfo) =>
  pairs([
    ['workspace', `${w.id} (roster epoch ${w.epoch})`],
    ['teams', w.teams.map((t) => t.slug).join(', ')],
  ]);
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
