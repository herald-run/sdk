import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ChatMessage, ChatRoom, Herald } from '@herald-run/sdk';
import { UsageError } from './compose';
export type ChatValues = {
  json?: boolean;
  exec?: string;
  session?: boolean;
  humans?: boolean;
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
const USAGE = 'Usage: herald chat list|read|send|wait|listen [ROOM] [TEXT]';
/** Chat text is written by another party: terminal control sequences are dropped. */
// eslint-disable-next-line no-control-regex -- removing control characters is the point.
const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const line = (m: ChatMessage) =>
  `${m.seq}  ${clean(m.sender)}  ${m.locked ? '[could not be verified]' : clean(m.text)}`;
const roomLine = (r: ChatRoom) =>
  [r.id, r.kind, `${r.unread} unread`, r.members.map((m) => m.principal).join(' ')].join('  ');
/** Runs `command` for one message: JSON on stdin, identifiers in the environment. */
export function runHandler(
  command: string,
  message: ChatMessage,
  env: Record<string, string | undefined>,
  timeout: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: {
        ...env,
        HERALD_CHAT_ROOM: message.room,
        HERALD_CHAT_SEQ: String(message.seq),
        HERALD_CHAT_SENDER: message.sender,
      },
      signal,
      timeout: timeout * 1000,
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Handler exited with ${code}.`)),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(message));
  });
}
export async function chat(
  client: Pick<Herald, 'chat'>,
  [action, room, text]: string[],
  values: ChatValues,
  io: Io,
): Promise<number> {
  const print = (human: string, data: unknown) =>
    io.out(values.json ? JSON.stringify(data) : human);
  const need = (value: string | undefined, name: string) => {
    if (!value) throw new UsageError(`${USAGE} (missing ${name})`);
    return value;
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
      });
      print(page.messages.map(line).join('\n') || 'No messages.', page);
      return 0;
    }
    case 'send': {
      const to = need(room, 'ROOM, owner, h:ID or a:ID');
      const body =
        text ??
        (values.bodyFile
          ? await readFile(values.bodyFile === '-' ? '/dev/stdin' : values.bodyFile, 'utf8')
          : need(undefined, 'TEXT'));
      const target = values.session ? (await client.chat.session(to)).id : to;
      const sent = await client.chat.send(target, body, {
        audience: values.humans ? 'humans' : undefined,
      });
      print(`${sent.room}  ${sent.seq}`, sent);
      return 0;
    }
    case 'wait': {
      const messages = await client.chat.wait(need(room, 'ROOM'), {
        after: values.after,
        timeout: values.timeout,
        signal: io.signal,
      });
      if (!messages.length) {
        io.err('No new messages.');
        return 3;
      }
      print(messages.map(line).join('\n'), { messages });
      return 0;
    }
    case 'listen': {
      const stop = new AbortController();
      const end = () => stop.abort();
      io.signal?.addEventListener('abort', end, { once: true });
      process.once('SIGINT', end);
      await client.chat.listen(
        (m) =>
          values.exec
            ? runHandler(values.exec, m, io.env, values.timeout, stop.signal)
            : print(line(m), m),
        {
          signal: stop.signal,
          rooms: room ? [room] : undefined,
          onError: (error, id) => io.err(`${id}: ${(error as Error).message}`),
        },
      );
      process.off('SIGINT', end);
      return 0;
    }
  }
  throw new UsageError(USAGE);
}
