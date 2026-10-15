// A minimal pull runner: registers a destination, then claims and completes its tasks.
import { readFile } from 'node:fs/promises';
import { Herald, type Message } from '@herald-run/sdk';

const herald = new Herald();
const destination = await herald.register(
  JSON.parse(await readFile(new URL('../destination.json', import.meta.url), 'utf8')),
);
const runnerId = 'example-' + process.pid;
async function run(task: Message) {
  if (task.direction !== 'outbound' || task.status !== 'queued') return;
  if (task.destinationId !== destination.id) return;
  const { lease } = await herald.claimTask(task.id, { runnerId }).catch(() => ({ lease: '' }));
  if (!lease) return; // Another runner claimed it.
  const prompt = String(task.input?.values.prompt ?? '');
  await herald.updateTask(task.id, {
    lease,
    logs: [{ sequence: 0, stream: 'stdout', text: `Working on: ${prompt}\n` }],
  });
  await herald.updateTask(task.id, { lease, status: 'completed' });
  console.log('completed', task.id);
}
console.log('Listening for tasks on', destination.key, '(Ctrl+C stops)');
herald.watch(run);
