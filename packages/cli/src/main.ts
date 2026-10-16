import { createWriteStream } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import * as e2ee from '@herald-run/sdk/e2ee';
import {
  Herald,
  HeraldError,
  duration,
  version,
  type Attachment,
  type Message,
  type MessageRequest,
} from '@herald-run/sdk';
import { configDirectory, defaultUrl, profileName, readProfiles, readSaved } from './config';
import { savedToken } from './config';
import { removeLogin, saveLogin, tokenPath } from './config';
import { uploadPath } from './files';
import * as format from './format';
import { aliases, commands, completion, usage } from './help';
import { integrate, type Run } from './integrate';
import { listen } from './listen';
import { encryptionLine, login, userAgent } from './login';
import { requestSecret, sendSecret, secretFailure } from './secrets';

/** A keyed client's verified account safety code; undefined for legacy tokens. */
async function safetyCode(client: Herald) {
  if (!client.keyed) return undefined;
  await client.keys();
  return client.fingerprint;
}
/** The server cannot search sealed content: filter up to five opened pages locally. */
async function searchOpened(client: Herald, query: Parameters<Herald['messages']>[0] & object) {
  const text = query.search!.toLowerCase();
  const found: Message[] = [];
  let before = query.before;
  for (let page = 0; page < 5; page++) {
    const list = await client.messages({ ...query, search: undefined, before });
    for (const m of list)
      if (
        [m.title, m.body, ...(m.fields || []).map((f) => f.label)]
          .join('\n')
          .toLowerCase()
          .includes(text)
      )
        found.push(m);
    if (!list.length || query.after !== undefined) break;
    const last = list.at(-1)!;
    before = `${last.createdAt}|${last.id}`;
  }
  return found;
}
export type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Raw stdout bytes (logs, downloads to `-`). */
  write: (chunk: string | Uint8Array) => void;
  env: Record<string, string | undefined>;
  home: string;
  /** Interactive prompt; absent when stdin is not a terminal. */
  ask?: (question: string) => Promise<string>;
  open: (url: string) => boolean;
  /** For `integrate`: the working directory and a shell-free program runner. */
  cwd?: string;
  run?: Run;
  /** Ends `watch` and `listen`; SIGINT otherwise. */
  signal?: AbortSignal;
};
class UsageError extends Error {}
/** Request outcomes as exit codes. */
const outcome: Record<string, number> = { answered: 0, expired: 3, cancelled: 4 };
const options = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  json: { type: 'boolean' },
  profile: { type: 'string' },
  url: { type: 'string' },
  input: { type: 'string', short: 'i' },
  out: { type: 'string', short: 'o' },
  file: { type: 'string', multiple: true },
  label: { type: 'string' },
  title: { type: 'string' },
  body: { type: 'string' },
  'reply-to': { type: 'string' },
  deadline: { type: 'string' },
  key: { type: 'string' },
  wait: { type: 'boolean' },
  timeout: { type: 'string' },
  target: { type: 'string' },
  config: { type: 'string' },
  concurrency: { type: 'string' },
  after: { type: 'string' },
  before: { type: 'string' },
  search: { type: 'string' },
  message: { type: 'string' },
  status: { type: 'string' },
  direction: { type: 'string' },
  name: { type: 'string' },
  scopes: { type: 'string' },
  'no-browser': { type: 'boolean' },
  'safety-code': { type: 'string' },
  scope: { type: 'string' },
  'dry-run': { type: 'boolean' },
} as const;
const globalOptions = ['help', 'version', 'json', 'profile', 'url'];
const integer = (value: string | undefined, name: string) => {
  if (value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(value)) throw new UsageError(`${name} must be a nonnegative integer.`);
  return Number(value);
};

/** Runs one CLI invocation and returns its exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const secret = argv.some((value) => ['request-secret', 'send-secret'].includes(value));
  let values: ReturnType<typeof parse>['values'], positionals: string[];
  const parse = () => parseArgs({ args: argv, allowPositionals: true, options, strict: true });
  try {
    ({ values, positionals } = parse());
  } catch (error) {
    io.err(secret ? secretFailure : (error as Error).message + ' Run herald help.');
    return 2;
  }
  if (values.version) {
    io.out(version);
    return 0;
  }
  let command = positionals[0] || 'help';
  command = aliases[command] || command;
  if (values.help || command === 'help') {
    const topic = command === 'help' ? positionals[1] : command;
    const name = topic && (aliases[topic] || topic);
    if (name && !commands[name]) {
      io.err(`Unknown command ${topic}. Run herald help.`);
      return 2;
    }
    io.out(usage(name));
    return 0;
  }
  const spec = commands[command];
  if (!spec) {
    io.err(`Unknown command ${command}. Run herald help.`);
    return 2;
  }
  const allowed = new Set([...globalOptions, ...(spec.options || [])]);
  const extra = Object.keys(values).find((name) => !allowed.has(name));
  if (extra) {
    io.err(
      secret
        ? secretFailure
        : `herald ${command} does not take --${extra}. Run herald help ${command}.`,
    );
    return 2;
  }
  const print = (human: string, json: unknown) => {
    if (values.json) io.out(JSON.stringify(json));
    else if (human) io.out(human);
  };
  try {
    const profile = profileName(values.profile || io.env.HERALD_PROFILE);
    const directory = configDirectory(io.home);
    const stored = profile === 'default' ? undefined : (await readProfiles(directory))[profile];
    const base = (values.url || io.env.HERALD_URL || stored?.url || defaultUrl).replace(/\/$/, '');
    let host: string;
    try {
      // The SDK validates the origin; never echo a malformed credential-bearing URL.
      host = new URL(new Herald({ url: base, apiKey: 'x' }).base).hostname;
    } catch {
      throw new Error(secret ? secretFailure : 'Use a valid Herald HTTPS server origin.');
    }
    const savedPath = tokenPath(directory, profile, host);
    const saved = await readSaved(savedPath);
    const token = io.env.HERALD_API_KEY || io.env.HERALD_TOKEN || savedToken(saved) || '';
    const client = new Herald({ url: base, apiKey: token, userAgent });
    const arg = (index: number, name: string) => {
      const value = positionals[index];
      if (!value) throw new UsageError(`Usage: herald ${command} ${spec.args || name}`);
      return value;
    };
    if (positionals.length > (spec.args?.split(' ').length ?? 0) + 1)
      throw new UsageError(`Too many arguments. Usage: herald ${command} ${spec.args || ''}`);
    const readInput = async () => JSON.parse(await readFile(values.input!, 'utf8'));
    const waitFor = async (id: string, timeout = duration(values.timeout || 3600)) => {
      const message = await client.wait(id, { waitTimeout: timeout });
      if (values.json) io.out(JSON.stringify(message));
      else if (message.status === 'answered') io.out(format.answer(message) || 'Answered.');
      else io.err(`Request ${message.status}. Message ID: ${message.id}`);
      return outcome[message.status] ?? 1;
    };
    switch (command) {
      case 'request-secret':
      case 'send-secret': {
        if (
          positionals.length !== 1 ||
          !(command === 'request-secret' ? values.out && !values.input : values.input)
        )
          throw new UsageError(secretFailure);
        const settings = {
          title: values.title,
          replyTo: values['reply-to'],
          label: values.label,
          deadline: duration(values.deadline || values.timeout || 3600),
          timeout: duration(values.timeout || 3600),
        };
        const result =
          command === 'request-secret'
            ? await requestSecret(client, values.out!, settings)
            : await sendSecret(client, values.input!, settings);
        print(`${result.id}  ${result.status}`, result);
        return 0;
      }
      case 'login': {
        const options = {
          name: values.name,
          scopes: values.scopes,
          safetyCode: values['safety-code'],
        };
        const result = await login(base, options, saved, {
          log: io.err,
          ask: io.ask,
          open: values['no-browser'] ? undefined : io.open,
        });
        await saveLogin(directory, profile, host, base, result.saved);
        io.err(
          result.reused
            ? `Connected. Reusing the stored token for ${result.saved.name}.`
            : `Connected to ${host}${profile === 'default' ? '' : ` as profile ${profile}`}. The token is stored locally.`,
        );
        if (result.saved.fingerprint) io.err(encryptionLine(result.saved.fingerprint));
        return 0;
      }
      case 'logout': {
        if (!saved.token) {
          io.err(`No stored token for ${host}.`);
          return 0;
        }
        try {
          await new Herald({ url: base, apiKey: saved.token, userAgent }).revokeToken();
          io.err('Token revoked.');
        } catch (error) {
          if (!(error instanceof HeraldError && error.status === 401))
            io.err(
              `Could not revoke the token (${(error as Error).message}). Revoke the connection in Settings.`,
            );
        }
        await removeLogin(savedPath);
        io.err('Local credentials removed.');
        return 0;
      }
      case 'whoami': {
        const [info, account, fingerprint] = await Promise.all([
          client.token(),
          client.account(),
          safetyCode(client),
        ]);
        const lines = [format.tokenSummary(info), format.accountSummary(account)];
        print([...lines, encryptionLine(fingerprint)].join('\n'), {
          token: info,
          account,
          e2ee: { enabled: !!fingerprint, safetyCode: fingerprint && e2ee.safetyCode(fingerprint) },
        });
        return 0;
      }
      case 'status': {
        const lines = [`server   ${base} (profile ${profile})`];
        let ping, info, problem;
        try {
          ping = await client.ping();
          lines.push(`version  ${ping.version} (${ping.channel})`);
        } catch (error) {
          problem = `unreachable: ${(error as Error).message}`;
        }
        if (ping && !token) problem = 'not signed in; run herald login';
        else if (ping) {
          try {
            info = await client.token();
            lines.push(`token    ${info.name} for ${info.account.email}`);
            const code = await safetyCode(client);
            lines.push(`e2ee     ${code ? `on (safety code ${e2ee.safetyCode(code)})` : 'off'}`);
          } catch (error) {
            problem = `token rejected: ${(error as Error).message}`;
          }
        }
        if (problem) lines.push(`problem  ${problem}`);
        print(lines.join('\n'), { server: base, profile, ping, token: info, problem });
        return problem ? 1 : 0;
      }
      case 'send':
      case 'ask': {
        const input: MessageRequest & Record<string, unknown> = values.input
          ? await readInput()
          : {
              title: values.title || 'A message for you',
              body: values.body || '',
              kind: 'message',
              fields: [],
            };
        const waiting = command === 'ask' || !!values.wait;
        if (waiting) {
          input.kind = 'form';
          if (!values.input)
            input.fields = [{ id: 'reply', type: 'textarea', label: 'Your reply', required: true }];
        }
        if (values['reply-to']) input.replyTo = values['reply-to'];
        if (values.deadline) {
          if (input.expiresAt || input.expiresIn)
            throw new UsageError('Use --deadline or expiresAt, not both.');
          input.expiresIn = duration(values.deadline);
        }
        const timeout = duration(values.timeout || 3600);
        const files: Attachment[] = [];
        for (const path of values.file || []) files.push(await uploadPath(client, path));
        if (files.length) input.attachments = [...(input.attachments || []), ...files];
        const message = await client.send(input, { idempotencyKey: values.key });
        if (!waiting) {
          print(message.id, message);
          return 0;
        }
        io.err(`Waiting for an answer to ${message.id}…`);
        return await waitFor(message.id, timeout);
      }
      case 'wait':
        return await waitFor(arg(1, '<message-id>'));
      case 'cancel': {
        const message = await client.cancel(arg(1, '<message-id>'));
        print(format.messageLine(message), message);
        return 0;
      }
      case 'messages':
      case 'search': {
        const status = values.status as Message['status'] | undefined;
        const direction = values.direction as 'inbound' | 'outbound' | undefined;
        if (direction && !['inbound', 'outbound'].includes(direction))
          throw new UsageError('--direction is inbound or outbound.');
        const query = {
          search: command === 'search' ? arg(1, '<text>') : values.search,
          status,
          direction,
          before: values.before,
          after: integer(values.after, '--after'),
        };
        const list =
          client.keyed && query.search
            ? await searchOpened(client, query)
            : await client.messages(query);
        print(list.map(format.messageLine).join('\n') || 'No messages.', list);
        return 0;
      }
      case 'show': {
        const message = await client.get(arg(1, '<message-id>'));
        print(format.messageDetail(message), message);
        return 0;
      }
      case 'thread': {
        const list: Message[] = [];
        for await (const message of client.threadMessages(arg(1, '<message-id>'))) {
          if (values.json) io.out(JSON.stringify(message));
          else list.push(message);
        }
        if (!values.json) io.out(list.map(format.messageLine).join('\n'));
        return 0;
      }
      case 'logs': {
        const logs = await client.taskLogs(arg(1, '<task-id>'), {
          after: integer(values.after, '--after'),
        });
        if (values.json) io.out(JSON.stringify(logs));
        else for (const log of logs) io.write(log.text);
        return 0;
      }
      case 'upload': {
        const file = await uploadPath(client, arg(1, '<file>'));
        const result = { id: file.id, name: file.name, size: file.size, type: file.type };
        print(`${file.id}  ${file.name}`, result);
        return 0;
      }
      case 'download': {
        const id = arg(1, '<file-id>');
        // Opening the message teaches a keyed client its attachments' keys.
        if (values.message) await client.get(values.message);
        const file = await client.download(id);
        const name = [...file.name]
          .filter((c) => c >= ' ' && c !== '\x7f')
          .join('')
          .trim();
        const path = values.out || (['', '.', '..'].includes(name) ? id : name);
        const body = Readable.fromWeb(file.body as import('node:stream/web').ReadableStream);
        if (path === '-') {
          for await (const chunk of body) io.write(chunk);
          return 0;
        }
        try {
          await pipeline(body, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
            await unlink(path).catch(() => {});
          throw error;
        }
        const { size } = await stat(path);
        print(`Saved ${path} (${size} bytes).`, { id, name: file.name, path, size });
        return 0;
      }
      case 'destinations': {
        const action = positionals[1] || 'list';
        if (action === 'list') {
          const list = await client.destinations();
          print(list.map(format.destinationLine).join('\n') || 'No destinations.', list);
        } else if (action === 'update') {
          if (!values.input) throw new UsageError('Usage: herald destinations update <id> -i file');
          const saved = await client.updateDestination(arg(2, '<id>'), await readInput());
          print(format.destinationLine(saved), saved);
        } else if (action === 'remove') {
          const id = arg(2, '<id>');
          await client.deleteDestination(id);
          print(`Removed ${id}.`, { id, removed: true });
        } else if (action === 'rotate-secret') {
          const rotated = await client.rotateDestinationSecret(arg(2, '<id>'));
          // The secret is the output; it is shown once.
          print(rotated.signingSecret, rotated);
        } else throw new UsageError(`Usage: herald destinations ${spec.args}`);
        return 0;
      }
      case 'register': {
        if (!values.input) throw new UsageError('Usage: herald register -i destination.json');
        const destination = await client.register(await readInput());
        print(
          format.destinationLine(destination) +
            (destination.signingSecret ? '\nsigning secret  ' + destination.signingSecret : ''),
          destination,
        );
        return 0;
      }
      case 'listen': {
        if (!values.config || !values.target)
          throw new UsageError('Usage: herald listen --target KEY --config runner.json');
        await listen(
          client,
          values.config,
          values.target,
          directory,
          io.signal,
          undefined,
          integer(values.concurrency, '--concurrency'),
        );
        return 0;
      }
      case 'watch': {
        const stop = new AbortController();
        const done = new Promise<void>((resolve) =>
          stop.signal.addEventListener('abort', () => resolve()),
        );
        const end = () => stop.abort();
        io.signal?.addEventListener('abort', end, { once: true });
        process.once('SIGINT', end);
        client.watch((message) => print(format.messageLine(message), message), {
          after: integer(values.after, '--after') ?? 0,
          signal: stop.signal,
        });
        await done;
        process.off('SIGINT', end);
        return 0;
      }
      case 'account': {
        const account = await client.account();
        print(format.accountSummary(account), account);
        return 0;
      }
      case 'integrate':
        return await integrate(
          arg(1, 'claude-code|codex'),
          { scope: values.scope, dryRun: values['dry-run'], profile, url: values.url },
          {
            ...io,
            cwd: io.cwd || process.cwd(),
            run: io.run || (async () => ({ code: 127, stdout: '' })),
          },
        );
      case 'completion': {
        const script = completion(arg(1, 'bash|zsh|fish'));
        if (!script) throw new UsageError('Usage: herald completion bash|zsh|fish');
        io.out(script);
        return 0;
      }
    }
    throw new UsageError(`Unknown command ${command}.`);
  } catch (error) {
    if (secret) {
      io.err(secretFailure);
      return error instanceof UsageError ? 2 : 1;
    }
    io.err((error as Error).message);
    if (error instanceof HeraldError && error.messageId) io.err('Message ID: ' + error.messageId);
    return error instanceof UsageError ? 2 : 1;
  }
}
