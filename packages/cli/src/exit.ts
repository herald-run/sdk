/**
 * Ends a finished command once stdout and stderr have drained: lingering sockets or prompts must
 * not keep it alive, but exiting earlier truncates output piped to a slow reader.
 */
export async function exitWhenDrained(
  streams: NodeJS.WritableStream[] = [process.stdout, process.stderr],
) {
  await Promise.all(
    streams.map((stream) => new Promise<void>((resolve) => stream.write('', () => resolve()))),
  );
  setTimeout(() => process.exit(), 500).unref();
}
