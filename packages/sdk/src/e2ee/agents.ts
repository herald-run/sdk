import type { SealedEnvelope } from '../schema/e2ee';
import { E2eeError } from './bytes';
import { open, seal, type Ctx, type Expect, type RecipientKey } from './envelope';
import type { ChatKeys } from './chat';

export const presenceStates = ['idle', 'busy', 'blocked', 'offline'] as const;
export type PresenceState = (typeof presenceStates)[number];
/** A link an agent shows next to its presence, such as a pull request or a dashboard. */
export interface AgentLink {
  /** 1 to 60 characters. */
  label: string;
  /** An http or https URL, up to 2048 characters. */
  url: string;
}
/** What an agent shows its owner: a state, and optionally its own colour, text, task and links. */
export interface AgentPresence extends Record<string, unknown> {
  state: PresenceState;
  color?: string;
  text?: string;
  /** What it is working on, up to 200 characters. */
  task?: string;
  /** Up to 8 links shown with the agent. */
  links?: AgentLink[];
}
/** A runtime subagent: a name the connection asserts for itself, with optional presence. */
export interface SubagentProfile extends AgentPresence {
  name: string;
  /**
   * Another subagent key of the same connection that started this one, so viewers can show a
   * tree. A missing or circular parent shows the subagent at the top level.
   */
  parent?: string;
}
/** A subagent key: 1 to 64 letters, digits, `.`, `_` or `-`. */
export const subagentKey = /^[\w.-]{1,64}$/;
export const agentLinkLimits = { links: 8, label: 60, url: 2048, task: 200 } as const;
export interface LayoutGroup {
  id: string;
  name: string;
  /** The group this one is nested in. */
  inside?: string;
}
export interface LayoutPlace {
  group?: string;
  /** An agent this one is placed under. */
  parent?: string;
}
/** One member's private arrangement of agents. Agents not listed sit at the top level. */
export interface AgentLayout extends Record<string, unknown> {
  groups: LayoutGroup[];
  places: Record<string, LayoutPlace>;
}
export const presenceContext = (account: string, principal: string): Ctx => ({
  t: 'presence',
  account,
  principal,
});
export const subagentContext = (account: string, principal: string, key: string): Ctx => ({
  t: 'subagent',
  account,
  principal,
  key,
});
export const layoutContext = (account: string, principal: string): Ctx => ({
  t: 'layout',
  account,
  principal,
});
const fail = (message: string): never => {
  throw new E2eeError(message);
};
const COLOR = /^#[0-9a-f]{6}$/i;
/** Why a link cannot be shown, or undefined when it can. */
export const agentLinkError = (link: unknown): string | undefined => {
  const { label, url } = (link ?? {}) as Partial<AgentLink>;
  if (typeof label !== 'string' || !label.trim() || label.length > agentLinkLimits.label)
    return `a label of 1 to ${agentLinkLimits.label} characters is required`;
  const message = `the URL must be http or https, up to ${agentLinkLimits.url} characters`;
  if (typeof url !== 'string' || url.length > agentLinkLimits.url) return message;
  try {
    if (['http:', 'https:'].includes(new URL(url).protocol)) return undefined;
  } catch {
    // An unparsable URL is invalid.
  }
  return message;
};
/** Sealing refuses what opening drops: a bad `task`, `links` or `parent` never costs the profile. */
const checkLinks = (links: unknown[]) => {
  const urls = new Set<string>();
  links.forEach((link, i) => {
    const error = agentLinkError(link);
    if (error) fail(`Invalid presence link ${i + 1}: ${error}.`);
    const { url } = link as AgentLink;
    if (urls.has(url)) fail(`Invalid presence link ${i + 1}: duplicate URL.`);
    urls.add(url);
  });
};
const keepLinks = (links: unknown): AgentLink[] => {
  const urls = new Set<string>();
  const kept: AgentLink[] = [];
  for (const link of Array.isArray(links) ? links : []) {
    if (agentLinkError(link) || urls.has(link.url)) continue;
    urls.add(link.url);
    kept.push({ label: link.label, url: link.url });
    if (kept.length === agentLinkLimits.links) break;
  }
  return kept;
};
const checkPresence = <T extends AgentPresence>(value: T, strict = true): T => {
  if (!value || !presenceStates.includes(value.state)) fail('Invalid presence state.');
  if (value.color !== undefined && (typeof value.color !== 'string' || !COLOR.test(value.color)))
    fail('Invalid presence colour.');
  if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 120))
    fail('Invalid presence text.');
  const { task, links } = value;
  const badTask =
    task !== undefined && (typeof task !== 'string' || task.length > agentLinkLimits.task);
  if (strict) {
    if (badTask) fail('Invalid presence task.');
    if (links !== undefined && (!Array.isArray(links) || links.length > agentLinkLimits.links))
      fail('Invalid presence links.');
    checkLinks(links ?? []);
    return value;
  }
  const kept = keepLinks(links);
  const out = { ...value };
  delete out.task;
  delete out.links;
  if (task !== undefined && !badTask) out.task = task;
  if (kept.length) out.links = kept;
  return out;
};
const validParent = (key: string, parent: unknown) =>
  typeof parent === 'string' && subagentKey.test(parent) && parent !== key;
const checkSubagent = (key: string, value: SubagentProfile, strict = true) => {
  const { parent, ...rest } = checkPresence(value, strict);
  if (parent === undefined) return rest as SubagentProfile;
  if (validParent(key, parent)) return { ...rest, parent } as SubagentProfile;
  if (strict) fail('Invalid subagent parent.');
  return rest as SubagentProfile;
};
const checkLayout = (value: AgentLayout): AgentLayout => {
  if (!value || !Array.isArray(value.groups) || !value.places || typeof value.places !== 'object')
    fail('Invalid layout.');
  return value;
};
const owners = (keys: ChatKeys, owner: string): RecipientKey[] => [
  keys.recipient(owner) ?? fail(`Unverified owner ${owner}.`),
];
async function openAs<T extends Record<string, unknown>>(
  keys: ChatKeys,
  envelope: SealedEnvelope,
  signer: string,
  expect: Expect,
): Promise<T> {
  const who = keys.verifier(signer) ?? fail(`Unverified signer ${signer}.`);
  if (envelope.from !== who.kid) fail('The document has the wrong signer.');
  return open<T>(envelope, {
    recipients: keys.openers,
    signers: (kid) => (kid === who.kid ? who.sign : undefined),
    expect,
  });
}
/** An agent seals its presence to its owner; `keys.principal` is the agent. */
export const sealPresence = (keys: ChatKeys, owner: string, presence: AgentPresence) =>
  seal({
    payload: checkPresence(presence),
    ctx: presenceContext(keys.account, keys.principal),
    signer: keys.signer,
    to: owners(keys, owner),
  });
/** The owner opens the presence a connection sealed. */
export async function openPresence(keys: ChatKeys, connection: string, envelope: SealedEnvelope) {
  const value = await openAs<AgentPresence>(keys, envelope, connection, {
    t: 'presence',
    account: keys.account,
    principal: connection,
  });
  return checkPresence(value, false);
}
export const sealSubagent = (
  keys: ChatKeys,
  owner: string,
  key: string,
  profile: SubagentProfile,
) => {
  if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 60)
    fail('Invalid subagent name.');
  return seal({
    payload: checkSubagent(key, profile),
    ctx: subagentContext(keys.account, keys.principal, key),
    signer: keys.signer,
    to: owners(keys, owner),
  });
};
export async function openSubagent(
  keys: ChatKeys,
  connection: string,
  key: string,
  envelope: SealedEnvelope,
) {
  const value = await openAs<SubagentProfile>(keys, envelope, connection, {
    t: 'subagent',
    account: keys.account,
    principal: connection,
    key,
  });
  if (typeof value.name !== 'string' || !value.name) fail('Invalid subagent name.');
  return checkSubagent(key, value, false);
}
/** A member seals their own layout to themselves. */
export const sealLayout = (keys: ChatKeys, layout: AgentLayout) =>
  seal({
    payload: checkLayout(layout),
    ctx: layoutContext(keys.account, keys.principal),
    signer: keys.signer,
    to: owners(keys, keys.principal),
  });
export async function openLayout(keys: ChatKeys, envelope: SealedEnvelope) {
  const value = await openAs<AgentLayout>(keys, envelope, keys.principal, {
    t: 'layout',
    account: keys.account,
    principal: keys.principal,
  });
  return checkLayout(value);
}
