import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Message } from './schema/index.js';
export function verifyWebhook(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
  tolerance = 300,
): { id: string; type: 'task.created'; task: Message } {
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > tolerance ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    !/^[a-f0-9]{64}$/i.test(signature)
  )
    throw new Error('Invalid or stale webhook.');
  const expected = createHmac('sha256', secret)
    .update(timestamp + '.' + body)
    .digest();
  const actual = Buffer.from(signature, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('Invalid webhook signature.');
  const event = JSON.parse(body);
  if (event.type !== 'task.created' || typeof event.id !== 'string' || event.task?.id !== event.id)
    throw new Error('Invalid webhook event.');
  return event;
}
