import { Herald, version } from '@herald-run/sdk';
import {
  configDirectory,
  defaultUrl,
  profileName,
  readProfiles,
  readSaved,
  tokenPath,
} from '@herald-run/cli/config';
export const userAgent = `herald-mcp/${version}`;
/**
 * A client per tool call, so a later `herald login` takes effect without a restart:
 * `HERALD_API_KEY`/`HERALD_TOKEN`, else the CLI's stored login for `HERALD_PROFILE`.
 */
export async function connect(env: Record<string, string | undefined>, home: string) {
  const profile = profileName(env.HERALD_PROFILE);
  const directory = configDirectory(home);
  const stored = profile === 'default' ? undefined : (await readProfiles(directory))[profile];
  const url = (env.HERALD_URL || stored?.url || defaultUrl).replace(/\/$/, '');
  const host = new URL(url).hostname;
  const apiKey =
    env.HERALD_API_KEY ||
    env.HERALD_TOKEN ||
    (await readSaved(tokenPath(directory, profile, host))).token;
  if (!apiKey)
    throw new Error(
      'Not signed in to Herald. Run `npx @herald-run/cli login` or set HERALD_API_KEY.',
    );
  return new Herald({ url, apiKey, userAgent });
}
