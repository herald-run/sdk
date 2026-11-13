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
it('sends a valid chat form', async () => {
  const ask = vi.fn(async () => ({ seq: 1, id: 'x', room: 'room' }));
  const form = JSON.stringify({
    title: 'Pick',
    fields: [{ id: 'a', type: 'select', label: 'A', options: [{ value: 'y', label: 'Yes' }] }],
  });
  await chat(fake({ ask }), ['ask', 'room'.padEnd(43, 'x'), form], base, io());
  expect(ask).toHaveBeenCalledTimes(1);
});
const room = 'r'.repeat(43);
it('sends as an agent with tags and a summary, and reads for one', async () => {
  const send = vi.fn(async () => ({ seq: 1, id: 'x', room }));
  const read = vi.fn(async () => ({ messages: [], through_seq: 0, hasMore: false }));
  const values = { ...base, as: 'a', tag: ['b'], summary: 'Plan', for: 'b' };
  await chat(fake({ send, read }), ['send', room, 'go'], values, io());
  expect(send).toHaveBeenCalledWith(
    room,
    'go',
    expect.objectContaining({ sub: 'a', tags: ['b'], summary: 'Plan' }),
  );
  await chat(fake({ send, read }), ['read', room], values, io());
  expect(read).toHaveBeenCalledWith(room, expect.objectContaining({ for: 'b' }));
});
it('sends a forward with optional text and refuses a malformed one', async () => {
  const send = vi.fn(async () => ({ seq: 1, id: 'x', room }));
  const values = { ...base, as: 'a', forward: `${room}:12` };
  await chat(fake({ send }), ['send', room], values, io());
  expect(send).toHaveBeenCalledWith(
    room,
    '',
    expect.objectContaining({ forward: { room, seq: 12 } }),
  );
  for (const forward of [`${room}:0`, 'x:1', room])
    await expect(
      chat(fake({ send }), ['send', room], { ...values, forward }, io()),
    ).rejects.toThrow('ROOM:SEQ');
});
it('needs --as to send to a person, and passes it as sub', async () => {
  const send = vi.fn(async () => ({ seq: 1, id: 'x', room }));
  const open = vi.fn(async () => ({ id: room }) as ChatRoom);
  await expect(chat(fake({ send }), ['send', 'owner', 'go'], base, io())).rejects.toThrow('--as');
  await expect(chat(fake({ send }), ['send', 'h:u', 'go'], base, io())).rejects.toThrow('--as');
  expect(send).not.toHaveBeenCalled();
  await chat(fake({ send }), ['send', 'owner', 'go'], { ...base, as: 'lead' }, io());
  expect(send).toHaveBeenCalledWith('owner', 'go', expect.objectContaining({ sub: 'lead' }));
  await chat(fake({ send, open }), ['send', 'h:u', 'go'], { ...base, as: 'lead' }, io());
  expect(open).not.toHaveBeenCalled();
});
it('creates a titled group and titles a room', async () => {
  const group = vi.fn(async () => ({ id: 'g'.repeat(43) }) as ChatRoom);
  const title = vi.fn(async () => ({ seq: 1, id: 'x', room: 'room' }));
  const values = { ...base, title: 'Launch', hopLimit: 10, agent: ['lead', 'qa'] };
  await chat(fake({ group }), ['group', 'a:one', 'h:two'], values, io());
  expect(group).toHaveBeenCalledWith(['a:one', 'h:two'], {
    agents: ['lead', 'qa'],
    title: 'Launch',
    hopLimit: 10,
  });
  await expect(chat(fake({ group }), ['group', 'h:two'], base, io())).rejects.toThrow('--agent');
  await chat(fake({ title }), ['title', 'room', 'New name'], base, io());
  expect(title).toHaveBeenCalledWith('room', 'New name', { sub: undefined });
  await chat(fake({ title }), ['title', 'room', 'New name'], { ...base, as: 'lead' }, io());
  expect(title).toHaveBeenLastCalledWith('room', 'New name', { sub: 'lead' });
  await expect(chat(fake({ group }), ['group'], values, io())).rejects.toThrow(/MEMBER/);
});
it('passes --as to react, edit and answer', async () => {
  const post = vi.fn(async () => ({ seq: 2, id: 'x', room: 'room' }));
  const values = { ...base, as: 'lead', remove: true };
  const c = fake({ react: post, edit: post, answer: post });
  await chat(c, ['react', 'room', '1', '+1'], values, io());
  expect(post).toHaveBeenLastCalledWith('room', 1, '+1', { remove: true, sub: 'lead' });
  await chat(c, ['edit', 'room', '1', 'fixed'], values, io());
  expect(post).toHaveBeenLastCalledWith('room', 1, 'fixed', { sub: 'lead' });
  await chat(c, ['answer', 'room', '1', '{"a":"y"}'], values, io());
  expect(post).toHaveBeenLastCalledWith('room', 1, { a: 'y' }, { sub: 'lead' });
});
it('passes --as to delete and --for to wait', async () => {
  const del = vi.fn(async () => {});
  const next = vi.fn(async () => undefined);
  const wait = vi.fn(async () => []);
  const c = fake({ delete: del, next, wait });
  await chat(c, ['delete', 'owner', '2'], { ...base, as: 'lead' }, io());
  expect(del).toHaveBeenCalledWith('owner', 2, { sub: 'lead' });
  await chat(c, ['wait', 'owner'], { ...base, for: 'lead' }, io());
  expect(next).toHaveBeenCalledWith('owner', expect.objectContaining({ for: 'lead' }));
  await chat(c, ['wait', 'owner'], { ...base, for: 'lead', after: 3 }, io());
  expect(wait).toHaveBeenCalledWith('owner', expect.objectContaining({ for: 'lead', after: 3 }));
});
