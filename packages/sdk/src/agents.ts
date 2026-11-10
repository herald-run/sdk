import type { AgentPresence, SubagentProfile, SubagentReach } from './e2ee/index.js';
import * as e2ee from './e2ee/index.js';
import type { KeyedSession } from './keyed.js';

export type { AgentPresence, PresenceState, SubagentProfile, SubagentReach } from './e2ee/index.js';
export type AgentPresenceOptions = {
  /** Seconds the presence stands without a refresh (10 to 86400, default 300). */
  ttl?: number;
};
export type SubagentOptions = AgentPresenceOptions & { reach?: SubagentReach };
export type OwnSubagent = { key: string; expiresAt: number; reach: SubagentReach };
type AgentsRequest = <T>(
  path: string,
  body?: unknown,
  options?: { method?: string; signal?: AbortSignal },
) => Promise<T>;
type Stored = { expiresAt: number; live?: boolean };
const KEY = /^[\w.-]{1,64}$/;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What this connection shows its owner. Presence and subagent names are sealed to the owner's
 * key, so Herald only sees when they expire. A connected chat stream keeps presence alive.
 */
export class AgentsClient {
  #request: AgentsRequest;
  #keyed: () => KeyedSession;
  #last?: { presence: AgentPresence; at: number; ttl: number };
  constructor(request: AgentsRequest, keyed: () => KeyedSession) {
    this.#request = request;
    this.#keyed = keyed;
  }
  /**
   * Sets state `idle`, `busy`, `blocked` or `offline`, with an optional colour and text. An
   * unchanged state only refreshes the expiry, which a live chat stream makes a no-op.
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
  /** Adds or renews a named child of this connection; the owner sees the name as self-asserted. */
  async setSubagent(
    key: string,
    profile: SubagentProfile,
    options: SubagentOptions = {},
  ): Promise<Stored> {
    if (!KEY.test(key)) throw new Error('A subagent key is 1 to 64 letters, digits, . _ or -.');
    const keys = await this.#keyed().chatKeys();
    const envelope = await e2ee.sealSubagent(keys, await this.#keyed().owner(), key, profile);
    return this.#request<Stored>(
      `/agents/me/subagents/${encodeURIComponent(key)}`,
      { envelope, ttl: options.ttl ?? 300, ...(options.reach ? { reach: options.reach } : {}) },
      { method: 'PUT' },
    );
  }
  /** Keeps a subagent listed for another `ttl` seconds without changing it. */
  renewSubagent(key: string, options: SubagentOptions = {}): Promise<Stored> {
    return this.#request<Stored>(
      `/agents/me/subagents/${encodeURIComponent(key)}`,
      { ttl: options.ttl ?? 300, ...(options.reach ? { reach: options.reach } : {}) },
      { method: 'PUT' },
    );
  }
  async removeSubagent(key: string): Promise<void> {
    await this.#request(`/agents/me/subagents/${encodeURIComponent(key)}`, undefined, {
      method: 'DELETE',
    });
  }
  async subagents(): Promise<OwnSubagent[]> {
    return (await this.#request<{ subagents: OwnSubagent[] }>('/agents/me/subagents')).subagents;
  }
}
