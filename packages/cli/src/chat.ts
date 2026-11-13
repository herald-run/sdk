import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ChatListing, ChatMessage, ChatWake, Herald } from '@herald-run/sdk';
import { UsageError } from './compose';
export type ChatValues = {
  json?: boolean;
  exec?: string;
  humans?: boolean;
  mention?: string[];
  attach?: string[];
  as?: string;
  agent?: string[];
  tag?: string[];
  summary?: string;
  /** `ROOM:SEQ`, a message of another room to show. */
  forward?: string;
  title?: string;
  hopLimit?: number;
  for?: string;
  remove?: boolean;
  after?: number;
  before?: number;
  limit?: number;
  timeout: number;
  bodyFile?: string;
};
type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
};
const ROOM_ID = /^[\w-]{43}$/;
const USAGE =
  'Usage: herald chat list|read|send|wait|listen|react|edit|delete|ask|answer|group|title [ROOM] [SEQ] [TEXT]';
/** `ROOM:SEQ` as a forward, with the id of the message read there. */
async function forwardOf(client: Pick<Herald, 'chat'>, value?: string) {
  if (value === undefined) return undefined;
  const [, room, seq] = /^([\w-]{43}):(\d+)$/.exec(value) ?? [];
  if (!room || !(Number(seq) >= 1)) throw new UsageError('--forward takes ROOM:SEQ.');
  const page = await client.chat.read(room, { after: Number(seq) - 1, limit: 1 });
  const found = page.messages.find((m) => m.seq === Number(seq));
  if (!found || found.locked || !['message', 'form'].includes(found.kind))
    throw new UsageError(`No message ${seq} in ${room}.`);
  return { room, seq: Number(seq), id: found.id };
}
/** Chat text is written by another party: terminal control sequences are dropped. */
// eslint-disable-next-line no-control-regex -- removing control characters is the point.
const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const line = (m: ChatMessage) =>
  `${m.seq}  ${clean(m.sender)}  ${m.locked ? '[could not be verified]' : clean(m.text)}` +
  (m.forward ? `  [forward ${m.forward.room}:${m.forward.seq}]` : '');
const roomLine = (r: ChatListing) =>
  [
    r.id,
    r.kind,
    r.title && clean(r.title),
    `${r.unread} unread`,
    r.members.map((m) => m.principal).join(' '),
  ]
    .filter(Boolean)
    .join('  ');
/** Runs `command` for one wake: JSON on stdin, identifiers in the environment. */
export function runHandler(
  command: string,
  wake: ChatWake,
  env: Record<string, string | undefined>,
  timeout: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: {
        ...env,
        HERALD_CHAT_ROOM: wake.room,
        HERALD_CHAT_SEQ: String(wake.seq),
        HERALD_CHAT_FIRST_SEQ: String(wake.first),
        HERALD_CHAT_REASON: wake.reason,
        HERALD_CHAT_CONTEXT: wake.context,
        HERALD_CHAT_SENDER: wake.messages.at(-1)?.sender ?? '',
      },
      signal,
      timeout: timeout * 1000,
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Handler exited with ${code}.`)),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(wake));
  });
}
export async function chat(
  client: Pick<Herald, 'chat'>,
  [action, room, ...rest]: string[],
  values: ChatValues,
  io: Io,
): Promise<number> {
  const print = (human: string, data: unknown) =>
    io.out(values.json ? JSON.stringify(data) : human);
  const need = (value: string | undefined, name: string) => {
    if (!value) throw new UsageError(`${USAGE} (missing ${name})`);
    return value;
  };
  const seqAt = (index: number) => {
    const seq = Number(rest[index]);
    if (!Number.isSafeInteger(seq) || seq <= 0) throw new UsageError(`${USAGE} (missing SEQ)`);
    return seq;
  };
  const body = async (text: string | undefined, name: string) =>
    text ??
    (values.bodyFile
      ? await readFile(values.bodyFile === '-' ? '/dev/stdin' : values.bodyFile, 'utf8')
      : need(undefined, name));
  const parsed = async (text: string | undefined, name: string) => {
    try {
      return JSON.parse(await body(text, name)) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError(`${name} must be JSON.`);
    }
  };
  const done = (sent: { room: string; seq: number }) => {
    print(`${sent.room}  ${sent.seq}`, sent);
    return 0;
  };
  /** A person's DM is with one of this connection's agents; its room id serves any attachment. */
  const dm = async (to: string) => {
    if (ROOM_ID.test(to)) return to;
    const agent = need(values.as, '--as KEY');
    return values.attach?.length ? (await client.chat.open(to, { agent })).id : to;
  };
  switch (action) {
    case 'list': {
      const rooms = await client.chat.list({ limit: values.limit, before: values.before });
      print(rooms.map(roomLine).join('\n') || 'No chats.', { rooms });
      return 0;
    }
    case 'read': {
      const page = await client.chat.read(need(room, 'ROOM'), {
        after: values.after,
        before: values.before,
        limit: values.limit,
        for: values.for,
      });
      print(page.messages.map(line).join('\n') || 'No messages.', page);
      return 0;
    }
    case 'send': {
      const to = need(room, 'ROOM, owner, h:ID or a:ID');
      const forward = await forwardOf(client, values.forward);
      const text =
        forward && rest[0] === undefined && !values.bodyFile ? '' : await body(rest[0], 'TEXT');
      const target = await dm(to);
      const attachments = [];
      for (const file of values.attach ?? [])
        attachments.push(
          await client.chat.attach(target, basename(file), new Uint8Array(await readFile(file))),
        );
      return done(
        await client.chat.send(target, text, {
          audience: values.humans ? 'humans' : undefined,
          mentions: values.mention,
          attachments: attachments.length ? attachments : undefined,
          sub: values.as,
          tags: values.tag,
          summary: values.summary,
          forward,
        }),
      );
    }
    case 'group': {
      const members = [room, ...rest].filter((m): m is string => !!m);
      if (!members.length) need(undefined, 'MEMBER');
      if (!values.agent?.length) need(undefined, '--agent KEY');
      const made = await client.chat.group(members, {
        agents: values.agent ?? [],
        title: values.title,
        hopLimit: values.hopLimit,
      });
      print(made.id, made);
      return 0;
    }
    case 'title':
      return done(
        await client.chat.title(need(room, 'ROOM'), need(rest[0], 'TEXT'), { sub: values.as }),
      );
    case 'react':
      return done(
        await client.chat.react(need(room, 'ROOM'), seqAt(0), need(rest[1], 'EMOJI'), {
          remove: values.remove,
          sub: values.as,
        }),
      );
    case 'edit':
      return done(
        await client.chat.edit(need(room, 'ROOM'), seqAt(0), await body(rest[1], 'TEXT'), {
          sub: values.as,
        }),
      );
    case 'delete': {
      await client.chat.delete(need(room, 'ROOM'), seqAt(0), { sub: values.as });
      print('Deleted.', { deleted: true });
      return 0;
    }
    case 'ask': {
      const { deadline, answerers, ...form } = await parsed(rest[0], 'FORM');
      return done(
        await client.chat.ask(await dm(need(room, 'ROOM')), form, {
          deadline: deadline as number | undefined,
          answerers: answerers as 'humans' | 'any' | undefined,
          sub: values.as,
          summary: values.summary,
        }),
      );
    }
    case 'answer':
      return done(
        await client.chat.answer(need(room, 'ROOM'), seqAt(0), await parsed(rest[1], 'ANSWERS'), {
          sub: values.as,
        }),
      );
    case 'wait': {
      const target = need(room, 'ROOM');
      const options = { timeout: values.timeout, signal: io.signal, for: values.for };
      if (values.after !== undefined) {
        const messages = await client.chat.wait(target, { ...options, after: values.after });
        if (!messages.length) {
          io.err('No new messages.');
          return 3;
        }
        print(messages.map(line).join('\n'), { messages });
        return 0;
      }
      const wake = await client.chat.next(target, options);
      if (!wake) {
        io.err('No new messages.');
        return 3;
      }
      print(`${wake.reason}\n` + wake.messages.map(line).join('\n'), wake);
      return 0;
    }
    case 'listen': {
      const stop = new AbortController();
      const end = () => stop.abort();
      io.signal?.addEventListener('abort', end, { once: true });
      process.once('SIGINT', end);
      const options = {
        signal: stop.signal,
        rooms: room ? [room] : undefined,
        for: values.for,
        onError: (error: unknown, id?: string) =>
          io.err((id ? id + ': ' : '') + (error as Error).message),
      };
      const exec = values.exec;
      await (exec
        ? client.chat.wakes((w) => runHandler(exec, w, io.env, values.timeout, stop.signal), {
            ...options,
            lease: values.timeout + 30,
          })
        : client.chat.listen((m) => print(line(m), m), options));
      process.off('SIGINT', end);
      return 0;
    }
  }
  throw new UsageError(USAGE);
}
