/** Every command: arguments, summary and the options it accepts besides the global ones. */
export type Spec = { args?: string; summary: string; options?: string[]; detail?: string };
const searchNote =
  'Content is end-to-end encrypted, so the server cannot search it: the newest five pages are decrypted and filtered locally.';
const message = ['input', 'title', 'body', 'body-file', 'kind', 'field', 'action', 'block'].concat([
  'file',
  'annotate',
  'review',
  'reply-to',
  'deadline',
  'key',
  'team',
]);
const compose = `Fields: ID[?]:TYPE[:LABEL[:CHOICES]], required unless ID ends with ?. TYPE: text, textarea,
number, boolean, select, multiselect, date, secret, file or secret-file (one file for this
connection only). LABEL (no colons) defaults to the ID; select and multiselect need CHOICES: a,b or
a=Label,b. Actions: ID[:LABEL] answers in one tap; every field must be optional, none secret or file.
Blocks: code, diff, json and table (CSV) read PATH (- for stdin); image attaches the file.
--annotate PDF attaches the PDF and adds an optional field "comments" (annotations): the answer
lists the user's comments, each on a page, selected text or an image, with text; once per message.
--out [FIELD=]PATH writes a secret or file answer to a new 0600 file (several files: a 0700
directory); every secret needs one, and values are never printed. PATH alone fits a single field.
With -i, flags win for title, body and kind and add fields, actions, blocks and files; an image
block there may give "file": PATH instead of attachmentId, as may an annotations field (a PDF). Instead of fields, -i input may give
"questions": [{question, header?, options: [{label, description?, preview?}], multiSelect?}],
answered as q1, q2… (each also accepts Other text).`;
export const commands: Record<string, Spec> = {
  login: {
    summary: 'Connect this device in the browser and store a token',
    options: ['name', 'scopes', 'no-browser', 'safety-code', 'workspace'],
    detail:
      'Default scopes: messages:send, messages:read, destinations:manage, events:read, files:write.\nThe approval also certifies an end-to-end key stored with the token. Confirm that the safety code matches the approval page, or pass it with --safety-code when not in a terminal.',
  },
  logout: { summary: 'Revoke the stored token and delete it locally' },
  whoami: { summary: 'Show the token, its scopes, the account or workspace and its safety code' },
  status: { summary: 'Check the server and the stored token' },
  send: {
    summary: 'Send a message; --wait waits for an answer',
    options: [...message, 'wait', 'timeout', 'out', 'secret-file'],
    detail:
      compose +
      '\n--secret-file offers a secret from a private file (≤16,000 bytes) and waits for its delivery.',
  },
  ask: {
    summary: 'Send a request and wait for the answer',
    options: [...message, 'timeout', 'out'],
    detail: compose + '\nWithout fields or actions, it asks for a free-text reply.',
  },
  wait: {
    args: '<message-id>',
    summary: 'Wait for a request to finish',
    options: ['timeout', 'out'],
    detail: 'Secret answers are shown as not collected unless --out FIELD=PATH stores them.',
  },
  cancel: { args: '<message-id>', summary: 'Cancel a pending request' },
  messages: {
    summary: 'List messages, newest first',
    options: ['search', 'status', 'direction', 'before', 'after'],
    detail: searchNote,
  },
  search: {
    args: '<text>',
    summary: 'Search messages',
    options: ['status', 'direction'],
    detail: searchNote,
  },
  show: { args: '<message-id>', summary: 'Show a message with its answer and logs' },
  thread: { args: '<message-id>', summary: 'List a thread, oldest first' },
  logs: { args: '<task-id>', summary: 'Print task logs', options: ['after'] },
  download: {
    args: '<file-id>',
    summary: 'Download an attachment (--out - writes stdout)',
    options: ['out', 'message'],
    detail: 'Files are end-to-end encrypted: --message names the message that carries the file.',
  },
  destinations: {
    args: '[list | update <id> -i file | remove <id> | rotate-secret <id>]',
    summary: "Manage this connection's destinations",
    options: ['input'],
  },
  register: {
    summary: 'Register or update a destination by key',
    options: ['input', 'target', 'webhook', 'description', 'type', 'field'],
    detail:
      'Each --field (no secret or file types) belongs to the --type before it. Tasks are pulled with herald listen unless --webhook is set. Session types need -i.',
  },
  listen: {
    summary: 'Run tasks for a pull destination',
    options: ['target', 'config', 'concurrency'],
    detail: 'The runner config may omit destinationId; --target then names the destination key.',
  },
  watch: { summary: 'Print messages as they change', options: ['after'] },
  account: { summary: 'Show the account holder, this connection, plan and usage' },
  completion: { args: 'bash|zsh|fish', summary: 'Print a shell completion script' },
  help: { args: '[command]', summary: 'Show help for a command' },
};
export const aliases: Record<string, string> = { get: 'show' };
const describe: Record<string, string> = {
  input: '-i, --input FILE   JSON input (message, form or destination)',
  title: '--title TEXT',
  body: '--body TEXT        Markdown body',
  'body-file': '--body-file PATH   Markdown body from a file (- for stdin)',
  kind: '--kind KIND        message (default), report or files; form with fields or waiting',
  field: '--field SPEC       Add a form field; repeatable (see above)',
  action: '--action ID[:LABEL] Add a one-tap answer; repeatable',
  block: '--block TYPE=PATH  Add a code, diff, json, table or image block; repeatable',
  review: '--review           Mark the request as needing review',
  'secret-file': '--secret-file PATH Offer the secret in a private file instead',
  file: '--file PATH        Attach a file; repeatable',
  annotate: '--annotate PDF      Attach a PDF for the user to comment on; once',
  'reply-to': '--reply-to ID      Reply in a thread',
  deadline: '--deadline 10m     Server deadline for the request',
  key: '--key KEY          Idempotency key for safe retries',
  wait: '--wait             Wait for the answer',
  timeout: '--timeout 1h       How long to wait (default 3600 s)',
  name: '--name NAME        Connection name (default: Herald CLI (<host>))',
  scopes: '--scopes LIST      all, or comma-separated scopes',
  'no-browser': '--no-browser       Print the approval link only',
  'safety-code': '--safety-code CODE Expected 30-digit account safety code (end-to-end encryption)',
  workspace: '--workspace SLUG   Connect to a team workspace instead of your personal account',
  team: "--team SLUG        Team to send to (team workspaces; default: the connection's first team)",
  search: '--search TEXT',
  status: '--status STATUS    pending, answered, expired, cancelled, ...',
  direction: '--direction DIR    inbound or outbound',
  before: '--before CURSOR    Older page: createdAt|id',
  after: '--after N          Revision or log sequence to start after',
  out: '-o, --out [FIELD=]PATH New output file (must not exist); repeatable for answers',
  target: '--target KEY       Destination key',
  webhook: '--webhook URL      Deliver tasks to a webhook instead of herald listen',
  description: '--description TEXT',
  type: '--type ID[:LABEL]  Add a request type; repeatable',
  config: '--config FILE      Runner config',
  concurrency: '--concurrency N    Tasks at once (1-16)',
  label: '--label TEXT',
  message: '--message ID       Message with the attachment (decrypts it)',
};
const globals = `Global options:
  --json             Machine-readable JSON output
  --profile NAME     Use a named profile (or HERALD_PROFILE)
  --url ORIGIN       Server (or HERALD_URL; default https://app.herald.run)
  --pin-file FILE    Team workspace pin for env tokens, kept current (or HERALD_PIN, read only)
  -h, --help         Show help
  --version          Print the version`;
export function usage(name?: string) {
  const spec = name && commands[name];
  if (!spec) {
    const width = Math.max(...Object.keys(commands).map((c) => c.length));
    return `Herald\n\nUsage: herald <command> [options]\n\nCommands:\n${Object.entries(commands)
      .map(([c, s]) => `  ${c.padEnd(width)}  ${s.summary}`)
      .join('\n')}\n\n${globals}

Exit codes: 0 success or answered, 1 error, 2 usage, 3 expired, 4 cancelled.
HERALD_API_KEY or HERALD_TOKEN supplies a token. Run herald help <command> for details.`;
  }
  const options = (spec.options || []).map((o) => '  ' + describe[o]);
  return [
    `Usage: herald ${name}${spec.args ? ' ' + spec.args : ''}${options.length ? ' [options]' : ''}`,
    '\n' + spec.summary + '.',
    spec.detail,
    options.length ? '\nOptions:\n' + options.join('\n') : undefined,
    '\n' + globals,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}
export function completion(shell: string) {
  const names = Object.keys(commands).join(' ');
  if (shell === 'bash')
    return `_herald() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=($(compgen -W "${names}" -- "$cur"));
  else COMPREPLY=($(compgen -f -W "--help --json --profile --url --pin-file" -- "$cur")); fi
}
complete -o default -F _herald herald`;
  if (shell === 'zsh')
    return `#compdef herald
_herald() {
  if (( CURRENT == 2 )); then compadd ${names}; else _files; fi
}
compdef _herald herald`;
  if (shell === 'fish')
    return Object.entries(commands)
      .map(
        ([c, s]) =>
          `complete -c herald -n __fish_use_subcommand -f -a ${c} -d ${JSON.stringify(s.summary)}`,
      )
      .join('\n');
  return undefined;
}
