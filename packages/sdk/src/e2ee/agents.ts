import type { SealedEnvelope } from '../schema/e2ee';
import { E2eeError } from './bytes';
import { open, seal, type Ctx, type Expect, type RecipientKey } from './envelope';
import type { ChatKeys } from './chat';

/** `busy` is the old name of `working`; the viewer shows it as Working. */
export const presenceStates = ['idle', 'working', 'busy', 'blocked', 'error', 'offline'] as const;
export type PresenceState = (typeof presenceStates)[number];
/** A link an agent shows next to its presence, such as a pull request or a dashboard. */
export interface AgentLink {
  /** 1 to 60 characters. */
  label: string;
  /** An http or https URL, up to 2048 characters. */
  url: string;
}
/** A labelled fact an agent lists about itself, shown in its About section. */
export interface AgentDetail {
  /** 1 to 40 characters once trimmed; unique within the list. */
  label: string;
  /** 1 to 200 characters once trimmed. */
  value: string;
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
  /** A path of nested section names, each 1 to 60 characters, at most 4 deep. */
  section?: string[];
  /** Sort position within its section or parent, then by name. */
  order?: number;
  /** Where a chat with it opens: the connection's direct chat, or a room. Absent: no chat. */
  chat?: AgentChat;
  /** The room it is working in now; viewers show its state and text there. */
  room?: string;
  /** Whether people can send it new requests. */
  requests?: boolean;
  /** Whether people who may send it requests can stop its current work (see `ChatClient.wakes`). */
  stoppable?: boolean;
  /** About text, up to 500 characters. */
  about?: string;
  /** Up to 12 labelled facts the agent defines, shown after its About text. */
  details?: AgentDetail[];
}
/** `'dm'`: people can DM the agent and add it to groups. `{ room }`: it lives in that room. */
export type AgentChat = 'dm' | { room: string };
/** An agent a connection registers: a name it asserts for itself, with optional presence. */
export interface SubagentProfile extends AgentPresence {
  name: string;
  /**
   * Another agent key of the same connection that started this one, so viewers can show a
   * tree. A missing or circular parent shows the agent at the top level of its section.
   */
  parent?: string;
}
/** A registered agent's sealed profile. */
export type AgentProfile = SubagentProfile;
/** An agent key: 1 to 64 letters, digits, `.`, `_` or `-`. */
export const subagentKey = /^[\w.-]{1,64}$/;
export const agentLinkLimits = { links: 8, label: 60, url: 2048, task: 200 } as const;
export const agentEntryLimits = { section: 60, sectionDepth: 4, about: 500 } as const;
export const agentDetailLimits = { entries: 12, label: 40, value: 200 } as const;
/** At most `colors` stored hues, keyed by ids of up to `id` characters. */
export const agentLayoutLimits = { colors: 512, id: 200 } as const;
const ROOM = /^[A-Za-z0-9_-]{1,64}$/;
const entryChecks: Record<string, (v: unknown) => boolean> = {
  section: (v) =>
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= agentEntryLimits.sectionDepth &&
    v.every((s) => typeof s === 'string' && !!s.trim() && s.length <= agentEntryLimits.section),
  order: (v) => typeof v === 'number' && Number.isFinite(v),
  chat: (v) =>
    v === 'dm' ||
    (!!v &&
      typeof v === 'object' &&
      typeof (v as { room?: unknown }).room === 'string' &&
      ROOM.test((v as { room: string }).room)),
  room: (v) => typeof v === 'string' && ROOM.test(v),
  requests: (v) => typeof v === 'boolean',
  stoppable: (v) => typeof v === 'boolean',
  about: (v) => typeof v === 'string' && v.length <= agentEntryLimits.about,
};
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
  /** Hues (0 to 360) given once to automatically coloured connections and agents, by id. */
  colors?: Record<string, number>;
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
    const parsed = new URL(url);
    if (['http:', 'https:'].includes(parsed.protocol))
      return parsed.username || parsed.password
        ? 'the URL must not contain credentials'
        : undefined;
  } catch {
    // An unparsable URL is invalid.
  }
  return message;
};
/** Sealing refuses what opening drops: a bad `task`, `links`, `details` or `parent` never costs the profile. */
const detailText = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= max ? v.trim() : undefined;
const cleanDetail = (detail: unknown): AgentDetail | undefined => {
  const { label, value } = (detail ?? {}) as Partial<AgentDetail>;
  const l = detailText(label, agentDetailLimits.label);
  const v = detailText(value, agentDetailLimits.value);
  return l !== undefined && v !== undefined ? { label: l, value: v } : undefined;
};
const checkDetails = (details: unknown): AgentDetail[] => {
  if (!Array.isArray(details) || details.length > agentDetailLimits.entries)
    return fail(`Invalid presence details: an array of up to ${agentDetailLimits.entries}.`);
  const labels = new Set<string>();
  return details.map((detail, i) => {
    const clean = cleanDetail(detail);
    if (!clean)
      return fail(
        `Invalid presence detail ${i + 1}: a label of 1 to ${agentDetailLimits.label} and a value of 1 to ${agentDetailLimits.value} characters are required.`,
      );
    if (labels.has(clean.label)) fail(`Invalid presence detail ${i + 1}: duplicate label.`);
    labels.add(clean.label);
    return clean;
  });
};
const keepDetails = (details: unknown): AgentDetail[] => {
  const labels = new Set<string>();
  const kept: AgentDetail[] = [];
  for (const detail of Array.isArray(details) ? details : []) {
    const clean = cleanDetail(detail);
    if (!clean || labels.has(clean.label)) continue;
    labels.add(clean.label);
    kept.push(clean);
    if (kept.length === agentDetailLimits.entries) break;
  }
  return kept;
};
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
  const { task, links, details } = value;
  const badTask =
    task !== undefined && (typeof task !== 'string' || task.length > agentLinkLimits.task);
  const bad = Object.keys(entryChecks).filter(
    (k) => value[k] !== undefined && !entryChecks[k](value[k]),
  );
  if (strict) {
    if (badTask) fail('Invalid presence task.');
    if (links !== undefined && (!Array.isArray(links) || links.length > agentLinkLimits.links))
      fail('Invalid presence links.');
    checkLinks(links ?? []);
    if (bad.length) fail(`Invalid presence ${bad[0]}.`);
    const out = details === undefined ? value : { ...value, details: checkDetails(details) };
    if (value.chat && typeof value.chat === 'object')
      return { ...out, chat: { room: value.chat.room } };
    return out;
  }
  const kept = keepLinks(links);
  const out = { ...value };
  delete out.task;
  delete out.links;
  delete out.details;
  for (const k of bad) delete out[k];
  if (out.chat && typeof out.chat === 'object') out.chat = { room: out.chat.room };
  if (task !== undefined && !badTask) out.task = task;
  if (kept.length) out.links = kept;
  const keptDetails = keepDetails(details);
  if (keptDetails.length) out.details = keptDetails;
  return out;
};
/**
 * Older viewers refuse states they do not know, so the wire carries `working` as `busy` and
 * `error` as `blocked` with `condition: 'error'`, which they pass through unread.
 */
const toWire = <T extends AgentPresence>(value: T): T => {
  if (value.state === 'working') return { ...value, state: 'busy' };
  if (value.state === 'error') return { ...value, state: 'blocked', condition: 'error' };
  return value;
};
const fromWire = <T extends AgentPresence>(value: T): T => {
  const { condition, ...rest } = value;
  return (
    condition === 'error' && value.state === 'blocked' ? { ...rest, state: 'error' } : rest
  ) as T;
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
const goodHue = ([id, hue]: [string, unknown]) =>
  !!id &&
  id.length <= agentLayoutLimits.id &&
  typeof hue === 'number' &&
  Number.isFinite(hue) &&
  hue >= 0 &&
  hue < 360;
/** Sealing refuses bad `colors`; opening keeps the valid entries, up to the limit. */
const checkLayout = (value: AgentLayout, strict = true): AgentLayout => {
  if (!value || !Array.isArray(value.groups) || !value.places || typeof value.places !== 'object')
    fail('Invalid layout.');
  const { colors } = value;
  if (colors === undefined) return value;
  const all = colors && typeof colors === 'object' && !Array.isArray(colors);
  const entries = all ? Object.entries(colors) : [];
  if (strict) {
    if (!all || entries.length > agentLayoutLimits.colors || !entries.every(goodHue))
      fail('Invalid layout colors.');
    return value;
  }
  const kept = entries.filter(goodHue).slice(0, agentLayoutLimits.colors);
  return { ...value, colors: Object.fromEntries(kept) };
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
    payload: toWire(checkPresence(presence)),
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
  return fromWire(checkPresence(value, false));
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
    payload: toWire(checkSubagent(key, profile)),
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
  return fromWire(checkSubagent(key, value, false));
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
  return checkLayout(value, false);
}
