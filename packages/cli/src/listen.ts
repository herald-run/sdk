import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { HeraldError, type Herald, type TaskClaim } from '@herald-run/sdk';
import type { Message } from '@herald-run/sdk/schema';
const configSchema = z.object({
  /** Optional: by default the destination registered with the `--target` key. */
  destinationId: z.string().uuid().optional(),
  command: z.string().refine(isAbsolute, 'Use an absolute executable path.'),
  args: z.array(z.string()).default([]),
  cwd: z.string().refine(isAbsolute, 'Use an absolute working directory.'),
  env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  timeout: z.number().int().min(1).max(86400).default(3600),
  /** Tasks run at once; 1 keeps the serial queue. */
  concurrency: z.number().int().min(1).max(16).default(1),
});
const LOG_INTERVAL = 2000;
const LOG_ATTEMPTS = 5;
/** Renews a lapsing task lease; the server re-queues tasks after five minutes of silence. */
const HEARTBEAT_INTERVAL = 60000;
type LogEntry = { sequence: number; stream: 'stdout' | 'stderr'; text: string };
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
type Journal = {
  cursor: number;
  jobs: Record<
    string,
    {
      lease: string;
      state: 'starting' | 'completed' | 'failed';
      reported?: boolean;
      error?: string;
    }
  >;
};
export async function listen(
  client: Herald,
  configPath: string,
  target: string,
  directory: string,
  signal?: AbortSignal,
  heartbeatInterval = HEARTBEAT_INTERVAL,
  concurrency?: number,
): Promise<void> {
  const config = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  const slots = configSchema.shape.concurrency.parse(concurrency ?? config.concurrency);
  const destinations = await client.destinations();
  const destinationId =
    config.destinationId ?? destinations.find((d) => d.key === target)?.id ?? '';
  if (!config.destinationId && !destinationId)
    throw new Error(`No destination has the key ${target}. Register it first: herald register.`);
  if (!destinations.some((d) => d.id === destinationId))
    throw new Error('The configured destination does not belong to this integration.');
  const name = createHash('sha256')
    .update(client.base + '\0' + destinationId + '\0' + target)
    .digest('hex');
  const path = join(directory, 'runners', name + '.json');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await open(path + '.lock', 'wx', 0o600).catch(() => {
    throw new Error(
      'This listener is already locked. Check the previous process before removing its lock file.',
    );
  });
  await lock.writeFile(String(process.pid));
  let journal: Journal = { cursor: 0, jobs: {} };
  // Saves are serialized: concurrent tasks share one journal file.
  let saving = Promise.resolve();
  const write = async () => {
    await writeFile(path + '.tmp', JSON.stringify(journal), { mode: 0o600 });
    await rename(path + '.tmp', path);
  };
  const save = () => (saving = saving.then(write, write));
  const controller = new AbortController();
  const children = new Set<ReturnType<typeof spawn>>();
  const inflight = new Map<string, Promise<void>>();
  let stopKill: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    controller.abort();
    for (const child of children) child.kill('SIGTERM');
    stopKill = setTimeout(() => {
      for (const child of children) child.kill('SIGKILL');
    }, 5000);
  };
  signal?.addEventListener('abort', stop, { once: true });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    try {
      journal = JSON.parse(await readFile(path, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (signal?.aborted) return;
    const report = async (id: string) => {
      const job = journal.jobs[id];
      if (job.reported) return;
      try {
        await client.updateTask(id, {
          lease: job.lease,
          status: job.state as 'completed' | 'failed',
          error: job.error,
        });
      } catch (e) {
        // 403: the lease lapsed and the task was re-queued for another runner.
        if (!(e instanceof HeraldError) || ![403, 404, 409, 410].includes(e.status)) throw e;
      }
      job.reported = true;
      await save();
    };
    for (const [id, job] of Object.entries(journal.jobs)) {
      if (job.state === 'starting') {
        job.state = 'failed';
        job.error =
          'Listener restarted; execution outcome is uncertain. Inspect before resubmitting.';
        await save();
      }
      if (!job.reported) await report(id);
    }
    // After a batch gives up, later batches try once until delivery recovers, so an
    // outage cannot hold the task outcome (and the serial task queue) for long.
    let logsDown = false;
    // Batches are keyed by their first sequence; the server also drops repeated sequences.
    const postLogs = async (id: string, lease: string, logs: LogEntry[]) => {
      for (let attempt = 1; ; attempt++) {
        try {
          await client.updateTask(
            id,
            { lease, logs },
            // This loop owns the retry policy, so an outage cannot stall the queue for long.
            { idempotencyKey: `${id}:logs:${logs[0].sequence}`, retry: false },
          );
          logsDown = false;
          return;
        } catch (e) {
          const retryable = !(e instanceof HeraldError) || e.status === 429 || e.status >= 500;
          if (!retryable) return;
          if (logsDown || attempt >= LOG_ATTEMPTS || controller.signal.aborted) {
            logsDown = true;
            return;
          }
          const seconds =
            e instanceof HeraldError && e.retryAfter !== undefined ? e.retryAfter : 2 ** attempt;
          await sleep(Math.min(seconds, 60) * 1000, controller.signal);
        }
      }
    };
    const execute = async (message: Message) => {
      if (
        message.direction !== 'outbound' ||
        message.destinationId !== destinationId ||
        controller.signal.aborted
      )
        return;
      const known = journal.jobs[message.id];
      if (known) {
        if (known.state !== 'starting' && !known.reported) await report(message.id);
        return;
      }
      if (!['queued', 'running'].includes(message.status)) return;
      let claim: TaskClaim;
      try {
        claim = await client.claimTask(message.id, { runnerId: name, heartbeat: true });
      } catch (e) {
        if (e instanceof HeraldError && e.status === 409) return;
        throw e;
      }
      if (message.status === 'running') {
        await client.updateTask(message.id, {
          lease: claim.lease,
          status: 'failed',
          error: 'Listener journal is missing; execution outcome is uncertain.',
        });
        journal.jobs[message.id] = { lease: claim.lease, state: 'failed' };
        await save();
        return;
      }
      journal.jobs[message.id] = { lease: claim.lease, state: 'starting' };
      await save();
      let sequence = 0,
        sent = 0,
        error = '',
        failed = false;
      let flush = Promise.resolve();
      const buffer = { stdout: '', stderr: '' };
      // Ordered queue; a backlog drains in server-sized (20 entry) batches.
      const pending: LogEntry[] = [];
      const flushLogs = () => {
        const queued = pending.length;
        for (const stream of ['stdout', 'stderr'] as const) {
          const text = buffer[stream];
          buffer[stream] = '';
          for (let i = 0; i < text.length; i += 4096)
            pending.push({ sequence: sequence++, stream, text: text.slice(i, i + 4096) });
        }
        if (pending.length > queued)
          flush = flush.then(async () => {
            if (pending.length) await postLogs(message.id, claim.lease, pending.splice(0, 20));
          });
      };
      const flushTimer = setInterval(flushLogs, LOG_INTERVAL);
      const env = Object.fromEntries(
        ['PATH', 'HOME', 'TMPDIR', ...config.env]
          .filter((k) => process.env[k] !== undefined)
          .map((k) => [k, process.env[k]!]),
      );
      env.HERALD_TASK_ID = message.id;
      env.HERALD_RUN_ID = message.runId || message.id;
      const child = spawn(config.command, config.args, {
        cwd: config.cwd,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.add(child);
      if (controller.signal.aborted) child.kill('SIGTERM');
      // Servers without lapsing leases return no expiry and need no heartbeat.
      let renewing = false;
      const heartbeat =
        claim.leaseExpiresAt &&
        setInterval(async () => {
          if (renewing) return;
          renewing = true;
          try {
            await client.heartbeatTask(message.id, claim.lease);
          } catch (e) {
            // Only a definitive lease loss stops the run; network errors and 5xx retry next tick.
            if (!(e instanceof HeraldError) || ![403, 409].includes(e.status)) return;
            failed = true;
            error = 'Task lease was lost.';
            child.kill('SIGTERM');
          } finally {
            renewing = false;
          }
        }, heartbeatInterval);
      const send = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const text = chunk.toString('utf8').slice(0, Math.max(0, 32000 - sent));
        sent += text.length;
        if (!text) return;
        buffer[stream] += text;
      };
      child.stdout!.on('data', (chunk) => send('stdout', chunk));
      child.stderr!.on('data', (chunk) => send('stderr', chunk));
      child.stdin!.on('error', () => {});
      child.stdin!.end(
        JSON.stringify({
          id: message.id,
          runId: message.runId,
          typeId: message.typeId,
          replyTo: message.replyTo,
          threadId: message.threadId,
          threadSequence: message.threadSequence,
          values: message.response?.values,
          session: message.session,
          attachments: message.attachments,
        }) + '\n',
      );
      const timeout = setTimeout(() => {
        failed = true;
        error = 'Local task timed out.';
        child.kill('SIGTERM');
      }, config.timeout * 1000);
      const kill = setTimeout(() => child.kill('SIGKILL'), config.timeout * 1000 + 5000);
      const code = await new Promise<number | null>((resolve) => {
        child.once('error', () => {
          failed = true;
          error = 'Could not start configured executable.';
          resolve(null);
        });
        child.once('close', resolve);
      });
      children.delete(child);
      clearTimeout(timeout);
      clearTimeout(kill);
      if (!children.size) clearTimeout(stopKill);
      clearInterval(flushTimer);
      if (heartbeat) clearInterval(heartbeat);
      flushLogs();
      // Logs are best effort; their delivery never decides the task outcome.
      await flush;
      const status = failed || controller.signal.aborted || code !== 0 ? 'failed' : 'completed';
      journal.jobs[message.id] = {
        lease: claim.lease,
        state: status,
        error: error || (code !== 0 ? 'Local process failed.' : undefined),
      };
      await save();
      await report(message.id);
    };
    // The cursor only passes revisions whose tasks have all finished, so a restart replays the rest.
    const order: Array<{ revision: number; done: boolean }> = [];
    const advance = async () => {
      let cursor = journal.cursor;
      while (order[0]?.done) cursor = Math.max(cursor, order.shift()!.revision);
      if (cursor === journal.cursor) return;
      journal.cursor = cursor;
      await save();
    };
    // With slots > 1 a failed attempt retries here, as the watch would redeliver it serially.
    const retrying = async (message: Message) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await execute(message);
        } catch (e) {
          if (controller.signal.aborted || attempt >= 5) throw e;
          await sleep(3000 * attempt, controller.signal);
        }
      }
    };
    const unwatch = client.watch(
      async (message) => {
        // A newer revision of a task that is still running.
        if (inflight.has(message.id)) return;
        while (inflight.size >= slots) await Promise.race(inflight.values());
        const entry = { revision: message.revision || 0, done: false };
        order.push(entry);
        const job = (slots === 1 ? execute(message) : retrying(message)).then(
          () => {
            inflight.delete(message.id);
            entry.done = true;
            return advance();
          },
          (e) => {
            inflight.delete(message.id);
            // Serially the watch redelivers it; otherwise it stays unacknowledged until restart.
            if (slots === 1) order.splice(order.indexOf(entry), 1);
            else
              console.error(`Task ${message.id} could not be processed: ${(e as Error).message}`);
            throw e;
          },
        );
        inflight.set(
          message.id,
          job.catch(() => {}),
        );
        if (slots === 1) await job;
      },
      { after: journal.cursor, signal: controller.signal },
    );
    await new Promise<void>((resolve) => {
      if (controller.signal.aborted) resolve();
      else controller.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    unwatch();
    await Promise.all(inflight.values());
    await saving;
  } finally {
    clearTimeout(stopKill);
    signal?.removeEventListener('abort', stop);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await lock.close();
    await unlink(path + '.lock');
  }
}
