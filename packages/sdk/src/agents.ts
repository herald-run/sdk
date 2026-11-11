import type { AgentPresence, AgentProfile, SubagentProfile, SubagentReach } from './e2ee/index.js';
import * as e2ee from './e2ee/index.js';
import type { KeyedSession } from './keyed.js';

export type {
  AgentChat,
  AgentLink,
  AgentPresence,
  AgentProfile,
  AgentReach,
  PresenceState,
  SubagentProfile,
  SubagentReach,
} from './e2ee/index.js';
export type AgentPresenceOptions = {
  /** Seconds the presence stands without a refresh (10 to 86400, default 300). */
  ttl?: number;
};
/** `reach: 'agents'` keeps people's messages and tags from reaching the agent. */
export type AgentOptions = AgentPresenceOptions & { reach?: SubagentReach };
export type OwnAgent = { key: string; expiresAt: number; reach: SubagentReach };
/** @deprecated Use `AgentOptions`. */
export type SubagentOptions = AgentOptions;
/** @deprecated Use `OwnAgent`. */
export type OwnSubagent = OwnAgent;
type AgentsRequest = <T>(
  path: string,
  body?: unknown,
  options?: { method?: string; signal?: AbortSignal },
) => Promise<T>;
type Stored = { expiresAt: number; live?: boolean };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The agents this connection registers for its owner. Profiles are sealed to the owner's key, so
 * Herald only sees each agent's key, reach and expiry.
 */
export class AgentsClient {
  #request: AgentsRequest;
  #keyed: () => KeyedSession;
  #last?: { presence: AgentPresence; at: number; ttl: number };
  #names = new Map<string, string>();
  #rooms = new Set<string>();
  constructor(request: AgentsRequest, keyed: () => KeyedSession) {
    this.#request = request;
    this.#keyed = keyed;
  }
  /**
   * The connection's own state. It no longer lists anything for people: register agents for
   * that. Kept for older readers; an unchanged state only refreshes the expiry.
   */
  async setPresence(presence: AgentPresence, options: AgentPresenceOptions = {}): Promise<Stored> {
    const ttl = options.ttl ?? 300;
    const last = this.#last;
    if (last && same(last.presence, presence) && Date.now() - last.at < (last.ttl * 1000) / 2)
      return { expiresAt: last.at + last.ttl * 1000 };
    if (last && same(last.presence, presence)) {
      const touched = await this.#request<Stored>(
        '/agents/me/presence',
        { ttl },
        { method: 'PUT' },
      );
      this.#last = { presence, at: Date.now(), ttl };
      return touched;
    }
    const keys = await this.#keyed().chatKeys();
    const envelope = await e2ee.sealPresence(keys, await this.#keyed().owner(), presence);
    const stored = await this.#request<Stored>(
      '/agents/me/presence',
      { envelope, ttl },
      { method: 'PUT' },
    );
    this.#last = { presence, at: Date.now(), ttl };
    return stored;
  }
  /**
   * Registers an agent under `key`, or updates it: it is listed while registered and unexpired.
   * The owner sees the name as self-asserted. `profile.parent` nests it under another agent key;
   * `profile.chat` of `{ room }` also adds it to that room, which this connection must be in.
   */
  async register(key: string, profile: AgentProfile, options: AgentOptions = {}): Promise<Stored> {
    if (!e2ee.subagentKey.test(key))
      throw new Error('An agent key is 1 to 64 letters, digits, . _ or -.');
    const keys = await this.#keyed().chatKeys();
    const envelope = await e2ee.sealSubagent(keys, await this.#keyed().owner(), key, profile);
    const stored = await this.#request<Stored>(
      `/agents/me/subagents/${encodeURIComponent(key)}`,
      { envelope, ttl: options.ttl ?? 300, ...(options.reach ? { reach: options.reach } : {}) },
      { method: 'PUT' },
    );
    this.#names.set(key, profile.name);
    const room = typeof profile.chat === 'object' ? profile.chat.room : undefined;
    if (room && !this.#rooms.has(`${room}/${key}`)) {
      await this.#request(
        `/chats/${encodeURIComponent(room)}/agents/${encodeURIComponent(key)}`,
        {},
        { method: 'PUT' },
      );
      this.#rooms.add(`${room}/${key}`);
    }
    return stored;
  }
  /** Keeps an agent registered for another `ttl` seconds without changing it. */
  renew(key: string, options: AgentOptions = {}): Promise<Stored> {
    return this.#request<Stored>(
      `/agents/me/subagents/${encodeURIComponent(key)}`,
      { ttl: options.ttl ?? 300, ...(options.reach ? { reach: options.reach } : {}) },
      { method: 'PUT' },
    );
  }
  /** Unlists an agent at once. Rooms keep it, so a person's tag can still wake this connection. */
  async unregister(key: string): Promise<void> {
    await this.#request(`/agents/me/subagents/${encodeURIComponent(key)}`, undefined, {
      method: 'DELETE',
    });
  }
  /** This connection's registered agents. */
  async list(): Promise<OwnAgent[]> {
    return (await this.#request<{ subagents: OwnAgent[] }>('/agents/me/subagents')).subagents;
  }
  /**
   * The name this client last registered for an agent key, kept after it is unregistered. Chat
   * messages and requests sent as an agent seal it, so readers can still show it later.
   */
  agentName(key: string): string | undefined {
    return this.#names.get(key);
  }
  /** @deprecated Use `register`. */
  setSubagent(key: string, profile: SubagentProfile, options: SubagentOptions = {}) {
    return this.register(key, profile, options);
  }
  /** @deprecated Use `renew`. */
  renewSubagent(key: string, options: SubagentOptions = {}) {
    return this.renew(key, options);
  }
  /** @deprecated Use `unregister`. */
  removeSubagent(key: string) {
    return this.unregister(key);
  }
  /** @deprecated Use `list`. */
  subagents(): Promise<OwnSubagent[]> {
    return this.list();
  }
  /** @deprecated Use `agentName`. */
  subagentName(key: string) {
    return this.agentName(key);
  }
}
