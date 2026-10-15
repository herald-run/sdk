// Receives webhook tasks: verifies the signature over the exact body and drops repeated deliveries.
import { createServer } from 'node:http';
import { verifyWebhook } from '@herald-run/sdk';

const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw new Error('Set WEBHOOK_SECRET to the signingSecret from registration.');
const seen = new Set<string>();
createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const header = (name: string) => String(request.headers[name] ?? '');
  try {
    const event = verifyWebhook(
      Buffer.concat(chunks).toString('utf8'),
      header('herald-timestamp'),
      header('herald-signature'),
      secret,
    );
    const delivery = header('herald-delivery') || event.id;
    if (!seen.has(delivery)) {
      seen.add(delivery);
      console.log('task', event.task.id, JSON.stringify(event.task.input?.values));
    }
    response.writeHead(204).end(); // Answer fast; do the work elsewhere.
  } catch {
    response.writeHead(401).end();
  }
}).listen(Number(process.env.PORT || 8787));
