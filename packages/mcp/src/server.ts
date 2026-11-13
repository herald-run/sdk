import { createWriteStream } from 'node:fs';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  agentLinkError,
  duration,
  HeraldError,
  version,
  type Herald,
  type Message,
  type MessageRequest,
} from '@herald-run/sdk';
import { fieldAnswers, questionsSchema, type Answers } from '@herald-run/sdk/schema';
import { uploadPath } from '@herald-run/cli/files';
import {
  fileFailure,
  requestFile,
  requestSecret,
  secretFailure,
  sendSecret,
} from '@herald-run/cli/secrets';

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
const threadKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe('A name you choose; messages sent with the same name share one thread');
const room = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .optional()
  .describe('The chat room this message belongs to; apps offer to open it');

/** Answers by question text when the request came from `questions`. */
const answers = (m: Message) =>
  m.response?.values && m.fields?.length
    ? fieldAnswers(m.fields, m.response.values as Answers)
    : undefined;

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
    ...(m.declined
      ? { declined: true, ...(m.decline?.note ? { declineNote: m.decline.note } : {}) }
      : {}),
    ...(m.response ? { actionId: m.response.actionId, values: m.response.values } : {}),
    answers: answers(m),
    ...(m.attachments?.length
      ? { attachments: m.attachments.map(({ id, name, size, type }) => ({ id, name, size, type })) }
      : {}),
    ...(m.e2ee ? { encrypted: true } : {}),
    ...(m.locked
      ? { note: 'End-to-end encrypted for other keys; this connection cannot read it.' }
      : {}),
    ...(m.unverified ? { note: 'Failed end-to-end verification; its content was withheld.' } : {}),
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
    'Send a message to the human in Herald (their inbox on web, macOS and Android). The body is Markdown. Attach local files (reports, logs, images, PDFs) by path. Returns the message ID and its thread ID; does not wait for a reply.',
    {
      title: z.string().min(1).max(180),
      body: z.string().max(50_000).optional().describe('Markdown'),
      files: files.optional(),
      replyTo,
      threadKey,
      room,
      idempotencyKey: z.string().max(200).optional().describe('Reuse to make retries safe'),
    },
    async ({ files: paths, idempotencyKey, ...input }, herald) => {
      const attachments = await attach(herald, paths);
      const kind = attachments.length && !input.body ? 'files' : 'message';
      const message = await herald.send({ ...input, kind, attachments }, { idempotencyKey });
      return json({ id: message.id, status: message.status, threadId: message.threadId });
    },
  );

  tool(
    'ask',
    'Ask the human a question in Herald and wait for the answer. Use approval for yes/no, choices for one of a few options, questions for multiple-choice questions (each with an Other answer), fields or schema (JSON Schema) for a form, or nothing for a free-text reply. Returns {status, values, actionId}, plus answers by question text for questions; if wait elapses first it returns status "pending" with the id for the wait tool.',
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
      questions: questionsSchema
        .optional()
        .describe(
          'Multiple-choice questions: [{question, header?, options: [{label, description?, preview? (Markdown)}], multiSelect?}]',
        ),
      files: files.optional(),
      replyTo,
      threadKey,
      room,
      refuseLabel: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe('Label of the button that declines the request (default Skip)'),
      deadline: time.optional().describe('When the request expires for the human (default 1h)'),
      wait: time.optional().describe('How long this call blocks (default 10m)'),
    },
    async (input, herald) => {
      const { approval, choices, questions } = input;
      const modes = [approval, choices, questions, input.fields || input.schema].filter(Boolean);
      if (modes.length > 1)
        return failure('Use one of approval, choices, questions, or fields/schema.');
      const deadline = duration(input.deadline || '1h');
      const request: MessageRequest = {
        title: input.title,
        body: input.body,
        kind: 'form',
        replyTo: input.replyTo,
        threadKey: input.threadKey,
        room: input.room,
        refuseLabel: input.refuseLabel,
        expiresIn: deadline,
        attachments: await attach(herald, input.files),
      };
      if (approval)
        request.actions = [
          { id: 'approve', label: 'Approve', values: {} },
          { id: 'reject', label: 'Reject', values: {} },
        ];
      else if (choices)
        request.actions = choices.map((label, i) => ({ id: `choice${i + 1}`, label, values: {} }));
      else if (questions) request.questions = questions;
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
      if (approval && result.status === 'answered') result.approved = result.actionId === 'approve';
      if (choices && typeof result.actionId === 'string')
        result.choice = choices[Number(result.actionId.slice(6)) - 1];
      return json(result);
    },
  );

  tool(
    'wait',
    'Wait for a pending Herald request to be answered, expire or be cancelled. Returns its status and answer (with answers by question text for questions); status "pending" means wait elapsed first.',
    { id, wait: time.optional().describe('How long to block (default 10m)') },
    async (input, herald) => json(await settle(herald, input.id, duration(input.wait || '10m'))),
    true,
  );

  tool(
    'threads',
    "List this integration's threads, newest first: id, message count, requests still waiting. Defaults to threads with a waiting request; all includes every retained thread. threadKey finds the thread of that name; a full page returns next, which before continues from.",
    {
      all: z.boolean().optional(),
      threadKey: threadKey,
      before: z.string().min(1).optional().describe('The next cursor of the previous page'),
    },
    async (input, herald) => json(await herald.threads(input)),
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
    'Get one Herald message or task with its answer (and answers by question text for questions), attachments, blocks and task result.',
    { id },
    async (input, herald) => {
      const message = await herald.get(input.id);
      return json({ ...message, answers: answers(message) });
    },
    true,
  );

  tool(
    'list_messages',
    'List recent Herald messages, newest first (up to 100), optionally filtered.',
    {
      search: z
        .string()
        .max(200)
        .optional()
        .describe('Sender name; content is end-to-end encrypted, so the server cannot search it'),
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

  const posting = {
    as: z
      .string()
      .min(1)
      .optional()
      .describe('Send as this registered agent key of the connection; required for a person'),
    summary: z.string().max(200).optional().describe('One line shown while it is collapsed'),
  };
  const acting = z
    .string()
    .min(1)
    .optional()
    .describe('Act as this registered agent key of the connection');
  const chatTarget = z
    .string()
    .min(1)
    .describe('Room id, or "owner", "h:<user>" or "a:<integration>" for a direct chat');
  const roomId = z.string().min(1).describe('Room id');
  tool(
    'chat_list',
    'List the end-to-end encrypted chat rooms this connection belongs to, newest first.',
    { limit: z.number().int().min(1).max(100).optional() },
    async (input, herald) => json(await herald.chat.list(input)),
    true,
  );
  tool(
    'chat_read',
    'Read one page of a chat, decrypted, oldest first. Use after to read forward from a seq.',
    {
      room: chatTarget,
      after: z.number().int().nonnegative().optional(),
      before: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      for: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Read as this agent key of the connection; names the DM for "owner", "h:…" or "a:…"',
        ),
    },
    async ({ room, ...options }, herald) => json(await herald.chat.read(room, options)),
    true,
  );
  /** A person's DM is with one of this connection's agents; its room id serves any attachment. */
  const dm = async (
    to: string,
    agent: string | undefined,
    attach: number | undefined,
    herald: Herald,
  ) => {
    if (/^[\w-]{43}$/.test(to)) return to;
    if (!agent) throw new Error('Sending to a person needs `as`, one of your registered agents.');
    return attach ? (await herald.chat.open(to, { agent })).id : to;
  };
  tool(
    'chat_send',
    'Send an end-to-end encrypted chat message; creates the direct chat if needed.',
    {
      to: chatTarget,
      text: z.string().optional().describe('Required unless forward is given'),
      humansOnly: z.boolean().optional().describe('Seal to humans only'),
      replyTo: z.number().int().positive().optional(),
      mentions: z.array(z.string().min(1)).optional().describe('Principals to tag'),
      paths: z.array(z.string().min(1)).optional().describe('Local files to attach'),
      ...posting,
      tags: z.array(z.string().min(1)).optional().describe('Subagent keys to address'),
      forward: z
        .object({ room: z.string(), seq: z.number().int().positive(), id: z.string() })
        .optional()
        .describe(
          'A message of another room (room, seq and id from chat_read); each reader opens it with their own access',
        ),
    },
    async ({ as, ...input }, herald) => {
      if (!input.text && !input.forward) throw new Error('Pass text, forward or both.');
      const target = await dm(input.to, as, input.paths?.length, herald);
      const attachments = [];
      for (const file of input.paths ?? [])
        attachments.push(
          await herald.chat.attach(target, basename(file), new Uint8Array(await readFile(file))),
        );
      return json(
        await herald.chat.send(target, input.text ?? '', {
          audience: input.humansOnly ? 'humans' : undefined,
          replyTo: input.replyTo,
          mentions: input.mentions,
          attachments: attachments.length ? attachments : undefined,
          sub: as,
          tags: input.tags,
          summary: input.summary,
          forward: input.forward,
        }),
      );
    },
  );
  const principals = z.array(z.string().regex(/^[ha]:/)).describe('h:<user> or a:<integration>');
  const groupAgents = z
    .array(
      z.union([
        z.string().min(1),
        z.object({
          connection: z.string().regex(/^a:/),
          key: z.string().min(1),
          notify: z.enum(['all', 'tagged', 'tagged_or_replied', 'never']).optional(),
        }),
      ]),
    )
    .describe(
      'Agents that take part: a key of this connection, or {connection, key} for another; one per connection',
    );
  tool(
    'chat_group',
    'Create an encrypted group from members (with an optional title), or with room add or remove members and set the title. An agent may add agents it can reach and people it already chats with, who own the group; as an owner it changes agents only.',
    {
      room: roomId.optional().describe('A group to change; omit to create one'),
      members: principals.optional(),
      agents: groupAgents.optional(),
      add: principals.optional(),
      remove: principals.optional(),
      hopLimit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe(
          'Agent turns in a row, between different agents, before wakes pause until a person writes (default 6)',
        ),
      title: z.string().min(1).max(200).optional().describe('Titles the group'),
      as: acting.describe(
        'Title as this registered agent key of the connection, for an existing group',
      ),
    },
    async ({ room, members, agents, add, remove, hopLimit, title, as }, herald) => {
      if (!room) {
        if (!agents?.length) return failure('Creating a group needs agents.');
        return json(await herald.chat.group(members ?? [], { agents, hopLimit, title }));
      }
      if (members || agents || hopLimit !== undefined)
        return failure(
          'members, agents and hopLimit only apply when creating a group; use add or remove.',
        );
      if (add || remove) await herald.chat.updateGroup(room, { add, remove });
      if (title) await herald.chat.title(room, title, { sub: as });
      return json(await herald.chat.open(room));
    },
  );
  const seq = z.number().int().positive();
  tool(
    'chat_react',
    'Add or remove an emoji reaction on a chat message. Wakes nobody.',
    {
      room: chatTarget,
      seq,
      emoji: z.string().min(1).max(32),
      remove: z.boolean().optional(),
      as: acting,
    },
    async (input, herald) =>
      json(
        await herald.chat.react(input.room, input.seq, input.emoji, {
          remove: input.remove,
          sub: input.as,
        }),
      ),
  );
  tool(
    'chat_edit',
    'Replace the text of a message this connection sent. Wakes nobody.',
    { room: chatTarget, seq, text: z.string().min(1), as: acting },
    async (input, herald) =>
      json(await herald.chat.edit(input.room, input.seq, input.text, { sub: input.as })),
  );
  tool(
    'chat_delete',
    'Delete a chat message this connection sent, leaving a tombstone.',
    { room: chatTarget, seq, as: acting },
    async (input, herald) => {
      await herald.chat.delete(input.room, input.seq, { sub: input.as });
      return json({ deleted: true });
    },
  );
  tool(
    'chat_ask',
    'Post a form in a chat. Humans answer by default; the first answer closes it and wakes only the asker.',
    {
      room: chatTarget,
      form: z.record(z.string(), z.unknown()).describe('Form definition, as in the Inbox'),
      deadline: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Epoch milliseconds, within 30 days'),
      anyone: z.boolean().optional().describe('Let agents answer as well'),
      ...posting,
    },
    async ({ room, form, deadline, anyone, as, ...rest }, herald) =>
      json(
        await herald.chat.ask(await dm(room, as, 0, herald), form, {
          deadline,
          answerers: anyone ? 'any' : undefined,
          sub: as,
          ...rest,
        }),
      ),
  );
  tool(
    'chat_answer',
    'Answer a form in a chat. Secret values are sealed to the asker alone.',
    {
      room: chatTarget,
      seq,
      answers: z.record(z.string(), z.unknown()),
      secrets: z.record(z.string(), z.unknown()).optional(),
      as: acting,
    },
    async ({ room, seq: form, answers, secrets, as }, herald) =>
      json(await herald.chat.answer(room, form, answers, { secrets, sub: as })),
  );
  tool(
    'chat_download',
    'Decrypt a chat attachment to a new local file (the path must not exist yet).',
    {
      room: roomId,
      seq,
      attachment: z.string().describe('Attachment id from the message'),
      path: z.string().min(1),
    },
    async (input, herald) => {
      const { messages } = await herald.chat.read(input.room, { after: input.seq - 1, limit: 1 });
      const file = messages[0]?.attachments?.find((a) => a.id === input.attachment);
      if (!file) throw new Error('No such attachment on that message.');
      const data = await herald.chat.download(input.room, file);
      await writeFile(input.path, data, { flag: 'wx', mode: 0o600 });
      return json({ path: input.path, name: file.name, size: file.size });
    },
  );
  tool(
    'chat_wait',
    'Wait for the next wake in a chat (or, with after, anything past that seq), decrypted and acknowledged. Returns reason, context, messages and history; an empty messages list on timeout.',
    {
      room: chatTarget,
      after: z.number().int().nonnegative().optional(),
      wait: time.optional().describe('How long this call blocks (default 10m)'),
      for: z
        .string()
        .min(1)
        .optional()
        .describe('Agent key of the connection whose DM "owner", "h:…" or "a:…" opens'),
    },
    async (input, herald) => {
      const timeout = duration(input.wait || '10m');
      if (input.after !== undefined)
        return json({
          messages: await herald.chat.wait(input.room, {
            after: input.after,
            timeout,
            for: input.for,
          }),
        });
      return json(
        (await herald.chat.next(input.room, { timeout, for: input.for })) ?? { messages: [] },
      );
    },
  );

  const link = z
    .object({ label: z.string().max(60), url: z.string().max(2048) })
    .superRefine((value, ctx) => {
      const message = agentLinkError(value);
      if (message) ctx.addIssue({ code: 'custom', message });
    });
  const look = {
    state: z.enum(['idle', 'busy', 'blocked', 'offline']),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe('Custom colour as #rrggbb'),
    ttl: z.number().int().min(10).max(86400).optional().describe('Seconds before it expires (300)'),
    task: z.string().max(200).optional().describe('What it is working on'),
    links: z
      .array(link)
      .max(8)
      .superRefine((links, ctx) => {
        const urls = new Set<string>();
        links.forEach((l, i) => {
          if (urls.has(l.url))
            ctx.addIssue({ code: 'custom', path: [i, 'url'], message: 'Duplicate URL.' });
          urls.add(l.url);
        });
      })
      .optional()
      .describe('http(s) links shown with it, such as a pull request'),
  };
  const subagentKey = z.string().regex(/^[\w.-]{1,64}$/);
  tool(
    'presence_set',
    'Show the account owner whether this connection is idle, busy, blocked or offline, end-to-end encrypted. Expires after ttl seconds unless refreshed.',
    { ...look, text: z.string().max(120).optional() },
    async ({ ttl, ...presence }, herald) =>
      json(await herald.agents.setPresence(presence, { ttl })),
  );
  tool(
    'agent_register',
    'Register an agent of this connection for the account owner, end-to-end encrypted. A connection chats only through its registered agents. It expires after ttl seconds unless registered again.',
    {
      key: subagentKey,
      name: z.string().min(1).max(60),
      parent: subagentKey.optional().describe('The agent key that started this one'),
      chat: z.boolean().optional().describe('People can DM it and add it to groups'),
      section: z
        .array(z.string().min(1).max(60))
        .min(1)
        .max(4)
        .optional()
        .describe('Section names it is listed under'),
      ...look,
      reach: z
        .enum(['all', 'agents'])
        .optional()
        .describe('agents: people cannot tag or message it; it reads agent messages only'),
    },
    async ({ key, ttl, reach, chat, ...profile }, herald) =>
      json(
        await herald.agents.register(
          key,
          { ...profile, ...(chat && { chat: 'dm' as const }) },
          { ttl, reach },
        ),
      ),
  );
  tool(
    'agent_unregister',
    "Unregister an agent of this connection, removing it from the account owner's view.",
    { key: subagentKey },
    async ({ key }, herald) => {
      await herald.agents.unregister(key);
      return json({ key, unregistered: true });
    },
  );
  tool(
    'agents_list',
    "List the keys and expiry of this connection's registered agents.",
    {},
    async (_input, herald) => json({ agents: await herald.agents.list() }),
    true,
  );
  tool(
    'subagent_set',
    'Name a subagent of this connection for the account owner, end-to-end encrypted. It costs no connection and expires after ttl seconds unless renewed.',
    {
      key: subagentKey,
      name: z.string().min(1).max(60),
      parent: subagentKey.optional().describe('The subagent key that started this one'),
      ...look,
      reach: z
        .enum(['all', 'agents'])
        .optional()
        .describe('agents: people cannot tag or message it; it reads agent messages only'),
    },
    async ({ key, ttl, reach, ...profile }, herald) =>
      json(await herald.agents.setSubagent(key, profile, { ttl, reach })),
  );
  tool(
    'subagent_remove',
    "Remove a subagent of this connection from the account owner's view.",
    { key: subagentKey },
    async ({ key }, herald) => {
      await herald.agents.removeSubagent(key);
      return json({ key, removed: true });
    },
  );
  tool(
    'subagents_list',
    "List the keys and expiry of this connection's subagents.",
    {},
    async (_input, herald) => json({ subagents: await herald.agents.subagents() }),
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
    {
      id,
      path: z.string().min(1),
      messageId: id.describe('Message carrying the attachment, which holds its key'),
    },
    async (input, herald) => {
      await herald.get(input.messageId);
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
    'request_file',
    'Ask the human for a file (key file, certificate, document) through an end-to-end encrypted Herald form and write it to a new file at path (mode 0600). Only this connection can decrypt it and Herald deletes it 15 minutes after the answer. The content is never returned; never print the file.',
    {
      path: z.string().min(1).describe('New file to create; must not exist'),
      label: z.string().max(120).optional().describe('Field label, such as "Kubeconfig"'),
      title: z.string().max(180).optional(),
      body: z.string().max(50000).optional().describe('Markdown: which file and why'),
      replyTo,
      wait: time.optional().describe('How long to wait for the human (default 10m)'),
    },
    async (input, herald) => {
      try {
        const timeout = duration(input.wait || '10m');
        const { title, label, body, replyTo: thread } = input;
        const settings = { title, label, body, replyTo: thread, deadline: timeout, timeout };
        const result = await requestFile(herald, input.path, settings);
        return json({ ...result, path: input.path });
      } catch {
        return failure(fileFailure);
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
