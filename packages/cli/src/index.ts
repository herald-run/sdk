import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { exitWhenDrained } from './exit';
import { main } from './main';
const ask = async (question: string) => {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
};
/** Opens an http(s) URL without a shell; false when no browser is likely available. */
function open(url: string) {
  const [command, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['rundll32', 'url.dll,FileProtocolHandler', url]
        : ['xdg-open', url];
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    return false;
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' })
      .on('error', () => {})
      .unref();
    return true;
  } catch {
    return false;
  }
}
const argv = process.argv.slice(2);
const again = (args: string[]) => {
  try {
    spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...args], {
      detached: true,
      stdio: 'ignore',
    })
      .on('error', () => {})
      .unref();
  } catch {
    /* Best effort. */
  }
};
// Hooks must never hold up the agent, whatever happens below.
if (argv[0] === 'fleet' && argv[1] === 'hook') setTimeout(() => process.exit(0), 2000).unref();
// A reader that closes early (`| head`) ends the command quietly.
process.stdout.on('error', () => process.exit());
process.exitCode = await main(argv, {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  write: (chunk) => process.stdout.write(chunk),
  env: process.env,
  home: homedir(),
  ask: process.stdin.isTTY ? ask : undefined,
  open,
  spawn: again,
  stdin: async () => {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return text;
  },
});
await exitWhenDrained();
