import { createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  duration,
  HeraldError,
  version,
  type Herald,
  type Message,
  type MessageRequest,
} from '@herald-run/sdk';
import { uploadPath } from '@herald-run/cli/files';
import { requestSecret, secretFailure, sendSecret } from '@herald-run/cli/secrets';

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
const json = (value: unknown): Result => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});
const failure = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true });
const time = z
  .string()
  .regex(/^\d+(\.\d+)?(s|m|h)?$/)
  .describe('Duration such as 90s, 10m or 2h (up to 24h)');
const id = z.string().min(1).max(100);
const files = z.array(z.string()).max(10).describe('Local file paths to attach (each ≤100 MB)');
const replyTo = id.optional().describe('Message ID to reply to, keeping a thread');

/** What an agent needs from a record; omits connection internals and keeps answers. */
function summary(m: Message) {
  return {
    id: m.id,
    title: m.title,
    status: m.status,
    kind: m.direction === 'outbound' ? 'task' : m.kind,
    direction: m.direction,
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
    threadId: m.threadId,
    replyTo: m.replyTo,
    ...(m.response ? { actionId: m.response.actionId, values: m.response.values } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
  };
}
const pendingNote = 'Still pending. Call wait with this id to keep waiting.';
/** Waits up to `seconds`; a client-side timeout leaves the request pending, not failed. */
async function settle(client: Herald, messageId: string, seconds: number) {
  try {
    return summary(await client.wait(messageId, { waitTimeout: seconds }));
  } catch (error) {
    if (error instanceof HeraldError && error.status === 408)
      return { id: messageId, status: 'pending', note: pendingNote };
    throw error;
  }
}

/** The Herald tools; `client` resolves credentials per call. */
export function createServer(client: () => Promise<Herald>) {
  const server = new McpServer({ name: 'herald', version });
  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Shape,
    run: (args: z.infer<z.ZodObject<Shape>>, herald: Herald) => Promise<Result>,
    readOnly = false,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: readOnly, openWorldHint: true } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's generic callback type.
      (async (args: any) => {
        try {
          return await run(args, await client());
        } catch (error) {
          const message = (error as Error).message;
          return failure(
            error instanceof HeraldError && error.messageId
              ? `${message} Message ID: ${error.messageId}`
              : message,
          );
        }
      }) as never,
    );
  const attach = async (herald: Herald, paths: string[] = []) => {
    const out = [];
    for (const path of paths) out.push(await uploadPath(herald, path));
    return out;
  };

  tool(
    'send',
    'Send a message to the human in Herald (their inbox on web, macOS and Android). The body is Markdown. Attach local files (reports, logs, images, PDFs) by path. Returns the message ID; does not wait for a reply.',
    {
      title: z.string().min(1).max(180),
      body: z.string().max(50_000).optional().describe('Markdown'),
      files: files.optional(),
      replyTo,
      idempotencyKey: z.string().max(200).optional().describe('Reuse to make retries safe'),
    },
    async ({ files: paths, idempotencyKey, ...input }, herald) => {
      const attachments = await attach(herald, paths);
      const kind = attachments.length && !input.body ? 'files' : 'message';
      const message = await herald.send({ ...input, kind, attachments }, { idempotencyKey });
      return json({ id: message.id, status: message.status });
    },
  );

  tool(
    'ask',
    'Ask the human a question in Herald and wait for the answer. Use approval for yes/no, choices for one of a few options, fields or schema (JSON Schema) for a form, or nothing for a free-text reply. Returns {status, values, actionId}; if wait elapses first it returns status "pending" with the id for the wait tool.',
    {
      title: z.string().min(1).max(180),
      body: z.string().max(50_000).optional().describe('Markdown context for the decision'),
      approval: z.boolean().optional().describe('Approve/Reject buttons; answer has approved'),
      choices: z
        .array(z.string().min(1).max(80))
        .min(2)
        .max(8)
        .optional()
        .describe('One button per choice; answer has choice'),
      fields: z
        .array(z.record(z.string(), z.unknown()))
        .max(30)
        .optional()
        .describe(
          'Herald form fields: {id, label, type: text|textarea|number|select|multiselect|boolean|date, required?, options?}',
        ),
      schema: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Flat JSON Schema object for the form, instead of fields'),
      files: files.optional(),
      replyTo,
      deadline: time.optional().describe('When the request expires for the human (default 1h)'),
      wait: time.optional().describe('How long this call blocks (default 10m)'),
    },
    async (input, herald) => {
      const modes = [input.approval, input.choices, input.fields || input.schema].filter(Boolean);
      if (modes.length > 1) return failure('Use one of approval, choices, or fields/schema.');
      const deadline = duration(input.deadline || '1h');
      const request: MessageRequest = {
        title: input.title,
        body: input.body,
        kind: 'form',
        replyTo: input.replyTo,
        expiresIn: deadline,
        attachments: await attach(herald, input.files),
      };
      const choices = input.choices;
      if (input.approval)
        request.actions = [
          { id: 'approve', label: 'Approve', values: {} },
          { id: 'reject', label: 'Reject', values: {} },
        ];
      else if (choices)
        request.actions = choices.map((label, i) => ({ id: `choice${i + 1}`, label, values: {} }));
      else if (input.schema) request.schema = input.schema;
      else
        request.fields = (input.fields as MessageRequest['fields']) || [
          { id: 'reply', type: 'textarea', label: 'Your reply', required: true },
        ];
      const message = await herald.send(request);
      const result: Record<string, unknown> = await settle(
        herald,
        message.id,
        Math.min(duration(input.wait || '10m'), deadline),
      );
      if (input.approval && result.status === 'answered')
        result.approved = result.actionId === 'approve';
      if (choices && typeof result.actionId === 'string')
        result.choice = choices[Number(result.actionId.slice(6)) - 1];
      return json(result);
    },
  );

  tool(
    'wait',
    'Wait for a pending Herald request to be answered, expire or be cancelled. Returns its status and answer; status "pending" means wait elapsed first.',
    { id, wait: time.optional().describe('How long to block (default 10m)') },
    async (input, herald) => json(await settle(herald, input.id, duration(input.wait || '10m'))),
    true,
  );

  tool(
    'cancel',
    'Cancel a pending Herald request so the human no longer sees it as open.',
    { id },
    async (input, herald) => json(summary(await herald.cancel(input.id))),
  );

  tool(
    'get_message',
    'Get one Herald message or task with its answer, attachments, blocks and task result.',
    { id },
    async (input, herald) => json(await herald.get(input.id)),
    true,
  );

  tool(
    'list_messages',
    'List recent Herald messages, newest first (up to 100), optionally filtered.',
    {
      search: z.string().max(200).optional(),
      status: z
        .enum([
          'pending',
          'answered',
          'delivered',
          'expired',
          'cancelled',
          'queued',
          'running',
          'completed',
          'failed',
        ])
        .optional(),
      direction: z
        .enum(['inbound', 'outbound'])
        .optional()
        .describe('inbound: sent to the human; outbound: tasks from the human'),
      before: z.string().optional().describe('Older page: createdAt|id of the last message seen'),
    },
    async (input, herald) => json((await herald.messages(input)).map(summary)),
    true,
  );

  tool(
    'thread',
    'List every message in the thread containing this message, oldest first.',
    { id },
    async (input, herald) => {
      const list = [];
      for await (const message of herald.threadMessages(input.id)) list.push(summary(message));
      return json(list);
    },
    true,
  );

  tool(
    'upload_file',
    'Upload a local file to Herald and return its attachment ({id, name, size, type}) for use in a later message.',
    { path: z.string().min(1) },
    async (input, herald) => json(await uploadPath(herald, input.path)),
  );

  tool(
    'download_file',
    'Download a Herald attachment to a new local file (the path must not exist yet).',
    { id, path: z.string().min(1) },
    async (input, herald) => {
      const file = await herald.download(input.id);
      const body = Readable.fromWeb(file.body as import('node:stream/web').ReadableStream);
      try {
        await pipeline(body, createWriteStream(input.path, { flags: 'wx', mode: 0o600 }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          await unlink(input.path).catch(() => {});
        throw error;
      }
      return json({
        id: input.id,
        name: file.name,
        path: input.path,
        size: (await stat(input.path)).size,
      });
    },
  );

  tool(
    'request_secret',
    'Ask the human for a secret (API key, token, password) through an end-to-end encrypted Herald form and write the decrypted value to a new file at path (mode 0600). The value is never returned; read the file where it is needed and never print it.',
    {
      path: z.string().min(1).describe('New file to create; must not exist'),
      label: z.string().max(120).optional().describe('Field label, such as "GitHub token"'),
      title: z.string().max(180).optional(),
      replyTo,
      wait: time.optional().describe('How long to wait for the human (default 10m)'),
    },
    async (input, herald) => {
      try {
        const timeout = duration(input.wait || '10m');
        const { title, label, replyTo: thread } = input;
        const settings = { title, label, replyTo: thread, deadline: timeout, timeout };
        const result = await requestSecret(herald, input.path, settings);
        return json({ ...result, path: input.path });
      } catch {
        // Fixed text only: errors may carry untrusted values.
        return failure(secretFailure);
      }
    },
  );

  tool(
    'send_secret',
    'Offer the human a secret read from a local file (≤16,000 bytes, UTF-8) through encrypted Herald delivery. Returns only the status, never the value.',
    {
      path: z.string().min(1).describe('File holding the secret'),
      title: z
        .string()
        .max(180)
        .optional()
        .describe('What the secret is, such as "Staging API key"'),
      replyTo,
      wait: time.optional().describe('How long to wait for the human to receive it (default 10m)'),
    },
    async (input, herald) => {
      try {
        const timeout = duration(input.wait || '10m');
        const result = await sendSecret(herald, input.path, {
          title: input.title,
          replyTo: input.replyTo,
          deadline: timeout,
          timeout,
        });
        return json(result);
      } catch {
        return failure(secretFailure);
      }
    },
  );
  return server;
}
