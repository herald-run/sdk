/** Every command: arguments, summary and the options it accepts besides the global ones. */
export type Spec = { args?: string; summary: string; options?: string[]; detail?: string };
const searchNote =
  'With end-to-end encryption the server cannot search content: the newest five pages are decrypted and filtered locally.';
const message = ['input', 'title', 'body', 'file', 'reply-to', 'deadline', 'key'];
export const commands: Record<string, Spec> = {
  login: {
    summary: 'Connect this device in the browser and store a token',
    options: ['name', 'scopes', 'no-browser', 'safety-code'],
    detail:
      'Default scopes: messages:send, messages:read, destinations:manage, events:read, files:write.\nOn accounts with end-to-end encryption, the approval also certifies a key stored with the token. Confirm that the safety code matches the approval page, or pass it with --safety-code when not in a terminal.',
  },
  logout: { summary: 'Revoke the stored token and delete it locally' },
  whoami: { summary: 'Show the token, its scopes, the account and end-to-end encryption' },
  status: { summary: 'Check the server and the stored token' },
  send: {
    summary: 'Send a message; --wait waits for an answer',
    options: [...message, 'wait', 'timeout'],
  },
  ask: { summary: 'Send a request and wait for the answer', options: [...message, 'timeout'] },
  wait: { args: '<message-id>', summary: 'Wait for a request to finish', options: ['timeout'] },
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
  upload: { args: '<file>', summary: 'Upload a file and print its attachment' },
  download: {
    args: '<file-id>',
    summary: 'Download an attachment (--out - writes stdout)',
    options: ['out', 'message'],
    detail: 'End-to-end encrypted files need --message, the message that carries them.',
  },
  destinations: {
    args: '[list | update <id> -i file | remove <id> | rotate-secret <id>]',
    summary: "Manage this connection's destinations",
    options: ['input'],
  },
  register: { summary: 'Register or update a destination by key', options: ['input'] },
  listen: {
    summary: 'Run tasks for a pull destination',
    options: ['target', 'config', 'concurrency'],
    detail: 'The runner config may omit destinationId; --target then names the destination key.',
  },
  watch: { summary: 'Print messages as they change', options: ['after'] },
  'request-secret': {
    summary: 'Request a secret into a new private file',
    options: ['out', 'label', 'title', 'reply-to', 'deadline', 'timeout'],
  },
  'send-secret': {
    summary: 'Offer a secret from a private file',
    options: ['input', 'title', 'reply-to', 'deadline', 'timeout'],
  },
  account: { summary: 'Show plan and usage' },
  integrate: {
    args: 'claude-code|codex',
    summary: 'Install Herald skills and register the MCP server for Claude Code or Codex',
    options: ['scope', 'dry-run'],
    detail:
      'User scope writes ~/.claude/skills or ~/.codex/skills and runs claude/codex mcp add; project scope writes .claude/skills + .mcp.json or .agents/skills + .codex/config.toml. Safe to rerun.',
  },
  completion: { args: 'bash|zsh|fish', summary: 'Print a shell completion script' },
  help: { args: '[command]', summary: 'Show help for a command' },
};
export const aliases: Record<string, string> = { get: 'show' };
const describe: Record<string, string> = {
  input: '-i, --input FILE   JSON input (message, form or destination)',
  title: '--title TEXT',
  body: '--body TEXT',
  file: '--file PATH        Attach a file; repeatable',
  'reply-to': '--reply-to ID      Reply in a thread',
  deadline: '--deadline 10m     Server deadline for the request',
  key: '--key KEY          Idempotency key for safe retries',
  wait: '--wait             Wait for the answer',
  timeout: '--timeout 1h       How long to wait (default 3600 s)',
  name: '--name NAME        Connection name (default: Herald CLI (<host>))',
  scopes: '--scopes LIST      all, or comma-separated scopes',
  'no-browser': '--no-browser       Print the approval link only',
  'safety-code': '--safety-code CODE Expected 30-digit account safety code (end-to-end encryption)',
  search: '--search TEXT',
  status: '--status STATUS    pending, answered, expired, cancelled, ...',
  direction: '--direction DIR    inbound or outbound',
  before: '--before CURSOR    Older page: createdAt|id',
  after: '--after N          Revision or log sequence to start after',
  out: '-o, --out PATH     Output file (must not exist)',
  target: '--target KEY       Destination key',
  config: '--config FILE      Runner config',
  concurrency: '--concurrency N    Tasks at once (1-16)',
  label: '--label TEXT',
  message: '--message ID       Message with the attachment (decrypts it)',
  scope: '--scope SCOPE      user (default) or project (current directory)',
  'dry-run': '--dry-run          Print the changes without making them',
};
const globals = `Global options:
  --json             Machine-readable JSON output
  --profile NAME     Use a named profile (or HERALD_PROFILE)
  --url ORIGIN       Server (or HERALD_URL; default https://app.herald.run)
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
  else COMPREPLY=($(compgen -f -W "--help --json --profile --url" -- "$cur")); fi
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
