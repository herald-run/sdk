import type { AgentLink, AgentPresence, Herald, PresenceState } from '@herald-run/sdk';
import { UsageError } from './compose';

export type AgentValues = {
  json?: boolean;
  state?: string;
  color?: string;
  ttl?: number;
  reach?: string;
  task?: string;
  link?: string[];
  parent?: string;
  chat?: boolean;
  section?: string;
};
type Io = { out: (line: string) => void };
const STATES: PresenceState[] = ['idle', 'busy', 'blocked', 'offline'];
const state = (value: string | undefined): PresenceState => {
  if (!STATES.includes(value as PresenceState))
    throw new UsageError(`State is one of ${STATES.join(', ')}.`);
  return value as PresenceState;
};
/** `--link LABEL=URL`: split at the first `=` followed by `http://` or `https://`. */
const link = (value: string): AgentLink => {
  const match = /^(.+?)=(https?:\/\/.*)$/is.exec(value);
  if (!match) throw new UsageError('Links are LABEL=URL with an http or https URL.');
  return { label: match[1], url: match[2] };
};
const shape = (state: PresenceState, text: string | undefined, values: AgentValues) => {
  const presence: AgentPresence = { state };
  if (text) presence.text = text;
  if (values.color) presence.color = values.color;
  if (values.task) presence.task = values.task;
  if (values.link?.length) presence.links = values.link.map(link);
  return presence;
};

/** `herald presence set STATE [TEXT]`: what this connection shows its owner. */
export async function presence(
  client: Pick<Herald, 'agents'>,
  [action, name, text]: string[],
  values: AgentValues,
  io: Io,
): Promise<number> {
  if (action !== 'set' || !name) throw new UsageError('Usage: herald presence set STATE [TEXT]');
  const stored = await client.agents.setPresence(shape(state(name), text, values), {
    ttl: values.ttl,
  });
  io.out(values.json ? JSON.stringify(stored) : `${name}${text ? '  ' + text : ''}`);
  return 0;
}

const reachOf = (value: string | undefined) => {
  if (value && value !== 'all' && value !== 'agents')
    throw new UsageError('Reach is all or agents.');
  return value as 'all' | 'agents' | undefined;
};

/** `herald agents list|register|unregister`: the agents of this connection that chat and show up. */
export async function agents(
  client: Pick<Herald, 'agents'>,
  [action = 'list', key, name]: string[],
  values: AgentValues,
  io: Io,
): Promise<number> {
  const print = (human: string, data: unknown) =>
    io.out(values.json ? JSON.stringify(data) : human);
  if (action === 'list') {
    const list = await client.agents.list();
    print(list.map((a) => a.key).join('\n') || 'No agents.', { agents: list });
  } else if (action === 'register') {
    if (!key || !name)
      throw new UsageError(
        'Usage: herald agents register KEY NAME [--chat] [--parent KEY] [--section A/B] [--ttl S]',
      );
    const section = values.section?.split('/').map((s) => s.trim());
    const profile = {
      ...shape(values.state ? state(values.state) : 'idle', undefined, values),
      name,
      ...(values.parent && { parent: values.parent }),
      ...(values.chat && { chat: 'dm' as const }),
      ...(section && { section }),
    };
    const stored = await client.agents.register(key, profile, {
      ttl: values.ttl,
      reach: reachOf(values.reach),
    });
    print(`${key}  ${name}`, stored);
  } else if (action === 'unregister') {
    if (!key) throw new UsageError('Usage: herald agents unregister KEY');
    await client.agents.unregister(key);
    print(`Unregistered ${key}.`, { key, unregistered: true });
  } else throw new UsageError('Usage: herald agents list|register|unregister [KEY] [NAME]');
  return 0;
}

/** `herald subagents list|set|remove`: named children of this connection. */
export async function subagents(
  client: Pick<Herald, 'agents'>,
  [action = 'list', key, name]: string[],
  values: AgentValues,
  io: Io,
): Promise<number> {
  const print = (human: string, data: unknown) =>
    io.out(values.json ? JSON.stringify(data) : human);
  if (action === 'list') {
    const list = await client.agents.subagents();
    print(list.map((s) => s.key).join('\n') || 'No subagents.', { subagents: list });
  } else if (action === 'set') {
    if (!key || !name) throw new UsageError('Usage: herald subagents set KEY NAME');
    const profile = {
      ...shape(values.state ? state(values.state) : 'idle', undefined, values),
      name,
      ...(values.parent && { parent: values.parent }),
    };
    const reach = reachOf(values.reach);
    const stored = await client.agents.setSubagent(key, profile, { ttl: values.ttl, reach });
    print(`${key}  ${name}`, stored);
  } else if (action === 'remove') {
    if (!key) throw new UsageError('Usage: herald subagents remove KEY');
    await client.agents.removeSubagent(key);
    print(`Removed ${key}.`, { key, removed: true });
  } else throw new UsageError('Usage: herald subagents list|set|remove [KEY] [NAME]');
  return 0;
}
