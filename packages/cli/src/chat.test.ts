import { expect, it, vi } from 'vitest';
import type { ChatMessage, ChatRoom, Herald } from '@herald-run/sdk';
import { chat, runHandler, type ChatValues } from './chat';
const message: ChatMessage = {
  room: 'r'.repeat(43),
  seq: 2,
  id: 'i',
  sender: 'h:u',
  sub: '',
  at: 1,
  kind: 'message',
  audience: 'all',
  text: 'hi\x1b[31m there',
  mine: false,
};
const base: ChatValues = { timeout: 5 };
const io = () => ({ out: vi.fn(), err: vi.fn(), env: { PATH: process.env.PATH } });
const fake = (over: Partial<Herald['chat']>) => ({ chat: over }) as unknown as Pick<Herald, 'chat'>;
it('strips terminal controls from chat text', async () => {
  const out = io();
  const page = { messages: [message], through_seq: 2, hasMore: false };
  await chat(fake({ read: async () => page }), ['read', 'room'], base, out);
  expect(out.out).toHaveBeenCalledWith('2  h:u  hi[31m there');
});
it('wait exits 3 when nothing arrives', async () => {
  const out = io();
  const code = await chat(fake({ next: async () => undefined }), ['wait', 'room'], base, out);
  expect(code).toBe(3);
});
it('runs a handler with the message on stdin and rejects a non-zero exit', async () => {
  const env = { PATH: process.env.PATH };
  const check = 'test "$(head -c 9)" = \'{"room":"\' && test "$HERALD_CHAT_SEQ" = 2';
  const wake = {
    room: message.room,
    first: 2,
    seq: 2,
    reason: 'mention' as const,
    context: 'message' as const,
    contextFrom: 2,
    messages: [message],
    history: [],
  };
  await expect(runHandler(check, wake, env, 5)).resolves.toBeUndefined();
  await expect(runHandler('exit 7', wake, env, 5)).rejects.toThrow('exited with 7');
});
it('refuses an invalid chat form before sending', async () => {
  const out = io();
  const ask = vi.fn();
  const form = JSON.stringify({
    title: 'Pick',
    fields: [{ id: 'a', type: 'choice', label: 'A' }],
  });
  await expect(chat(fake({ ask }), ['ask', 'room', form], base, out)).rejects.toThrow(
    /Invalid form: fields 0 type/,
  );
  expect(ask).not.toHaveBeenCalled();
});
it('sends a valid chat form', async () => {
  const ask = vi.fn(async () => ({ seq: 1, id: 'x', room: 'room' }));
  const form = JSON.stringify({
    title: 'Pick',
    fields: [{ id: 'a', type: 'select', label: 'A', options: [{ value: 'y', label: 'Yes' }] }],
  });
  await chat(fake({ ask }), ['ask', 'room', form], base, io());
  expect(ask).toHaveBeenCalledTimes(1);
});
it('sends as a subagent with tags and a summary, and reads for one', async () => {
  const send = vi.fn(async () => ({ seq: 1, id: 'x', room: 'room' }));
  const read = vi.fn(async () => ({ messages: [], through_seq: 0, hasMore: false }));
  const values = { ...base, sub: 'a', tag: ['b'], summary: 'Plan', for: 'b' };
  await chat(fake({ send, read }), ['send', 'room', 'go'], values, io());
  expect(send).toHaveBeenCalledWith(
    'room',
    'go',
    expect.objectContaining({ sub: 'a', tags: ['b'], summary: 'Plan' }),
  );
  await chat(fake({ send, read }), ['read', 'room'], values, io());
  expect(read).toHaveBeenCalledWith('room', expect.objectContaining({ for: 'b' }));
});
it('creates a titled group and titles a room', async () => {
  const group = vi.fn(async () => ({ id: 'g'.repeat(43) }) as ChatRoom);
  const title = vi.fn(async () => ({ seq: 1, id: 'x', room: 'room' }));
  await chat(fake({ group }), ['group', 'a:one', 'h:two'], { ...base, title: 'Launch' }, io());
  expect(group).toHaveBeenCalledWith(['a:one', 'h:two'], { title: 'Launch' });
  await chat(fake({ title }), ['title', 'room', 'New name'], base, io());
  expect(title).toHaveBeenCalledWith('room', 'New name');
  await expect(chat(fake({ group }), ['group'], base, io())).rejects.toThrow(/MEMBER/);
});
