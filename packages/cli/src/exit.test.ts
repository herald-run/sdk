import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'win32')('drains piped output before exiting', () => {
  const module = pathToFileURL(join(import.meta.dirname, 'exit.ts')).href;
  const script = `import { exitWhenDrained } from ${JSON.stringify(module)};
for (let i = 0; i < 8; i++) process.stdout.write(Buffer.alloc(1 << 20, 97));
setInterval(() => {}, 1000);
await exitWhenDrained();`;
  // The reader starts late, so the pipe stays full past the 500 ms grace period.
  const count = execFileSync(
    'sh',
    ['-c', `"${process.execPath}" --input-type=module -e '${script}' | (sleep 1; wc -c)`],
    { encoding: 'utf8', timeout: 20000 },
  );
  expect(Number(count.trim())).toBe(8 << 20);
});
