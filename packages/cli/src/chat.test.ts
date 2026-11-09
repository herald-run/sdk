import { expect, it, vi } from 'vitest';
import type { ChatMessage, Herald } from '@herald-run/sdk';
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
  const code = await chat(fake({ wait: async () => [] }), ['wait', 'room'], base, out);
  expect(code).toBe(3);
});
it('runs a handler with the message on stdin and rejects a non-zero exit', async () => {
  const env = { PATH: process.env.PATH };
  const check = 'test "$(head -c 9)" = \'{"room":"\' && test "$HERALD_CHAT_SEQ" = 2';
  await expect(runHandler(check, message, env, 5)).resolves.toBeUndefined();
  await expect(runHandler('exit 7', message, env, 5)).rejects.toThrow('exited with 7');
});
