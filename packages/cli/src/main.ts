import { createWriteStream } from 'node:fs';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import * as e2ee from '@herald-run/sdk/e2ee';
import { Herald, HeraldError, duration, version, type Message } from '@herald-run/sdk';
import { configDirectory, defaultUrl, profileName, readProfiles, readSaved } from './config';
import { savedToken } from './config';
import { removeLogin, saveLogin, tokenPath } from './config';
import { composeDestination, composeMessage, outputs, UsageError } from './compose';
import * as format from './format';
import { aliases, commands, completion, usage } from './help';
import { listen } from './listen';
import { encryptionLine, login, userAgent } from './login';
import { collect, fileFailure, isSecret, sendSecret, secretFailure } from './secrets';
import type { Field } from '@herald-run/sdk/schema';

/** The token's verified account safety code. */
async function safetyCode(client: Herald) {
  await client.keys();
  return client.fingerprint!;
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
  /** All of stdin, for `-` paths. */
  stdin?: () => Promise<string>;
  /** Ends `watch` and `listen`; SIGINT otherwise. */
  signal?: AbortSignal;
};
/** Request outcomes as exit codes. */
const outcome: Record<string, number> = { answered: 0, expired: 3, cancelled: 4 };
const options = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  json: { type: 'boolean' },
  profile: { type: 'string' },
  url: { type: 'string' },
  'pin-file': { type: 'string' },
  input: { type: 'string', short: 'i' },
  out: { type: 'string', short: 'o', multiple: true },
  file: { type: 'string', multiple: true },
  annotate: { type: 'string', multiple: true },
  'body-file': { type: 'string' },
  kind: { type: 'string' },
  field: { type: 'string', multiple: true },
  action: { type: 'string', multiple: true },
  block: { type: 'string', multiple: true },
  review: { type: 'boolean' },
  'secret-file': { type: 'string' },
  webhook: { type: 'string' },
  description: { type: 'string' },
  type: { type: 'string', multiple: true },
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
  workspace: { type: 'string' },
  team: { type: 'string' },
} as const;
const globalOptions = ['help', 'version', 'json', 'profile', 'url', 'pin-file'];
/** A team workspace pin file: absent means no pin yet; anything else must be a valid pin. */
async function readPin(path: string) {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  return text === undefined ? undefined : e2ee.parseWorkspacePin(text);
}
const integer = (value: string | undefined, name: string) => {
  if (value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(value)) throw new UsageError(`${name} must be a nonnegative integer.`);
  return Number(value);
};

/** The answer as JSON: stored fields name their path instead of a value. */
function shown(message: Message, stored: Record<string, string>) {
  if (!message.response || !Object.keys(stored).length) return message;
  const values: Record<string, unknown> = { ...message.response.values };
  for (const [field, path] of Object.entries(stored)) values[field] = { stored: path };
  return { ...message, response: { ...message.response, values } };
}
/** Fixed failure text once secrets are involved: errors may carry untrusted values. */
const failureFor = (fields: Field[]) =>
  fields.some((f) => f.type === 'secret')
    ? secretFailure
    : fields.some(isSecret)
      ? fileFailure
      : undefined;
/** Runs one CLI invocation and returns its exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  // Secret transfers print fixed failures only: errors may carry untrusted values.
  let quiet = argv.some((v) => v === '--secret-file' || v.startsWith('--secret-file='))
    ? secretFailure
    : undefined;
  let values: ReturnType<typeof parse>['values'], positionals: string[];
  let tokens: ReturnType<typeof parse>['tokens'];
  const parse = () =>
    parseArgs({ args: argv, allowPositionals: true, options, strict: true, tokens: true });
  try {
    ({ values, positionals, tokens } = parse());
  } catch (error) {
    io.err(quiet ?? (error as Error).message + ' Run herald help.');
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
    io.err(quiet ?? `herald ${command} does not take --${extra}. Run herald help ${command}.`);
    return 2;
  }
  // A newer workspace pin being stored; awaited before exiting.
  let saving: Promise<void> | undefined;
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
      throw new Error(quiet ?? 'Use a valid Herald HTTPS server origin.');
    }
    const savedPath = tokenPath(directory, profile, host);
    const saved = await readSaved(savedPath);
    // Login and logout work from an outdated login; everything else needs a keyed token.
    const keyless = ['login', 'logout'].includes(command);
    const env = io.env.HERALD_API_KEY || io.env.HERALD_TOKEN;
    const token = (keyless ? '' : env || savedToken(saved)) || '';
    // A saved team workspace login keeps its pin current, so a server cannot roll it back.
    const pinned = !keyless && !env && saved.workspace;
    // Env tokens: `--pin-file` is read and kept current; `HERALD_PIN` is read only.
    const pinFile = keyless ? undefined : values['pin-file'];
    const envPin = !keyless && !pinned && io.env.HERALD_PIN;
    const client = new Herald({
      url: base,
      apiKey: token,
      userAgent,
      ...(pinned && {
        workspace: saved.workspace,
        pin: saved.pin,
        onPin: (pin: e2ee.WorkspacePin) => {
          saving = saveLogin(directory, profile, host, base, { ...saved, pin }).catch(() => {});
        },
      }),
      ...(envPin && { pin: e2ee.parseWorkspacePin(envPin) }),
      ...(pinFile && {
        pin: await readPin(pinFile),
        onPin: (pin: e2ee.WorkspacePin) => {
          saving = writeFile(pinFile, JSON.stringify(pin) + '\n').catch(() => {});
        },
      }),
    });
    const arg = (index: number, name: string) => {
      const value = positionals[index];
      if (!value) throw new UsageError(`Usage: herald ${command} ${spec.args || name}`);
      return value;
    };
    if (positionals.length > (spec.args?.split(' ').length ?? 0) + 1)
      throw new UsageError(`Too many arguments. Usage: herald ${command} ${spec.args || ''}`);
    const readInput = async () => JSON.parse(await readFile(values.input!, 'utf8'));
    const timeout = duration(values.timeout || 3600);
    const report = (message: Message, stored: Record<string, string> = {}) => {
      if (values.json) io.out(JSON.stringify(shown(message, stored)));
      else if (message.status === 'answered') io.out(format.answer(message, stored) || 'Answered.');
      else io.err(`Request ${message.status}. Message ID: ${message.id}`);
      return outcome[message.status] ?? 1;
    };
    const waitFor = async (id: string) => report(await client.wait(id, { waitTimeout: timeout }));
    switch (command) {
      case 'login': {
        const options = {
          name: values.name,
          scopes: values.scopes,
          safetyCode: values['safety-code'],
          workspace: values.workspace,
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
        io.err(encryptionLine(result.saved.fingerprint!));
        return 0;
      }
      case 'logout': {
        if (!saved.token) {
          io.err(`No stored token for ${host}.`);
          return 0;
        }
        try {
          if (!saved.seed) throw new Error('it has no end-to-end key');
          await new Herald({ url: base, apiKey: savedToken(saved), userAgent }).revokeToken();
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
        const [info, account, fingerprint, workspace] = await Promise.all([
          client.token(),
          client.account(),
          safetyCode(client),
          client.workspace(),
        ]);
        const lines = [format.tokenSummary(info, account), encryptionLine(fingerprint)];
        if (workspace) lines.splice(1, 0, format.workspaceSummary(workspace));
        print(lines.join('\n'), {
          token: info,
          account,
          ...(workspace && { workspace }),
          e2ee: { enabled: true, safetyCode: e2ee.safetyCode(fingerprint) },
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
            lines.push(`e2ee     on (safety code ${e2ee.safetyCode(code)})`);
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
        if (values['secret-file']) {
          const used = ['input', 'body-file', 'kind', 'field', 'action', 'block', 'file']
            .concat(['annotate', 'review', 'key', 'wait', 'out'])
            .find((name) => values[name as keyof typeof values] !== undefined);
          if (used) throw new UsageError(`--secret-file does not take --${used}.`);
          const result = await sendSecret(client, values['secret-file'], {
            title: values.title,
            body: values.body,
            replyTo: values['reply-to'],
            team: values.team,
            deadline: duration(values.deadline || values.timeout || 3600),
            timeout,
          });
          print(`${result.id}  ${result.status}`, result);
          return 0;
        }
        const waiting = command === 'ask' || !!values.wait;
        const stdin = io.stdin || (() => Promise.reject(new UsageError('stdin is unavailable.')));
        const base = values.input ? await readInput() : undefined;
        const draft = await composeMessage(values, base, waiting, stdin);
        if (values.out && !waiting) throw new UsageError('--out needs --wait.');
        const outs = outputs(values.out || [], draft.fields, waiting);
        quiet = failureFor(draft.fields);
        const send = async () => {
          await draft.attach(client);
          const message = await client.send(draft.input, { idempotencyKey: values.key });
          if (waiting) io.err(`Waiting for an answer to ${message.id}…`);
          return message;
        };
        if (!waiting) {
          const message = await send();
          print(message.id, message);
          return 0;
        }
        if (!outs.length) return await waitFor((await send()).id);
        const start = async () => (await send()).id;
        const { message, stored } = await collect(
          client,
          outs,
          start,
          timeout,
          quiet ?? fileFailure,
        );
        return report(message, stored);
      }
      case 'wait': {
        const id = arg(1, '<message-id>');
        if (!values.out) return await waitFor(id);
        const fields = (await client.get(id)).fields;
        const outs = outputs(values.out, fields, true);
        quiet = failureFor(fields);
        const start = async () => id;
        const { message, stored } = await collect(
          client,
          outs,
          start,
          timeout,
          quiet ?? fileFailure,
          true,
        ).catch((error) => {
          if (error instanceof HeraldError && error.status === 408)
            quiet = `Timed out; ${id} is still pending.`;
          throw error;
        });
        return report(message, stored);
      }
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
        const list = query.search
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
      case 'download': {
        const id = arg(1, '<file-id>');
        if (!values.message)
          throw new UsageError('Usage: herald download <file-id> --message <id>');
        // Opening the message teaches the client its attachments' keys.
        await client.get(values.message);
        const file = await client.download(id);
        const name = [...file.name]
          .filter((c) => c >= ' ' && c !== '\x7f')
          .join('')
          .trim();
        if ((values.out?.length ?? 0) > 1) throw new UsageError('download takes one --out.');
        const path = values.out?.[0] || (['', '.', '..'].includes(name) ? id : name);
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
        const base = values.input ? await readInput() : undefined;
        const destination = await client.register(composeDestination(base, values, tokens));
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
        const [account, info] = await Promise.all([client.account(), client.token()]);
        print(format.accountSummary(account, info.account), account);
        return 0;
      }
      case 'completion': {
        const script = completion(arg(1, 'bash|zsh|fish'));
        if (!script) throw new UsageError('Usage: herald completion bash|zsh|fish');
        io.out(script);
        return 0;
      }
    }
    throw new UsageError(`Unknown command ${command}.`);
  } catch (error) {
    if (quiet) {
      io.err(quiet);
      return error instanceof UsageError ? 2 : 1;
    }
    io.err((error as Error).message);
    if (error instanceof HeraldError && error.messageId) io.err('Message ID: ' + error.messageId);
    return error instanceof UsageError ? 2 : 1;
  } finally {
    await saving;
  }
}
