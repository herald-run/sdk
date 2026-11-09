import type { SealedEnvelope } from '../schema/e2ee';
import { E2eeError } from './bytes';
import { open, seal, type Ctx, type Expect, type RecipientKey } from './envelope';
import type { ChatKeys } from './chat';

export const presenceStates = ['idle', 'busy', 'blocked', 'offline'] as const;
export type PresenceState = (typeof presenceStates)[number];
/** What an agent shows its owner: a state, and optionally its own colour and text. */
export interface AgentPresence extends Record<string, unknown> {
  state: PresenceState;
  color?: string;
  text?: string;
}
/** A runtime subagent: a name the connection asserts for itself, with optional presence. */
export interface SubagentProfile extends AgentPresence {
  name: string;
}
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
const checkPresence = <T extends AgentPresence>(value: T): T => {
  if (!value || !presenceStates.includes(value.state)) fail('Invalid presence state.');
  if (value.color !== undefined && (typeof value.color !== 'string' || !COLOR.test(value.color)))
    fail('Invalid presence colour.');
  if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 120))
    fail('Invalid presence text.');
  return value;
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
  return checkPresence(value);
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
    payload: checkPresence(profile),
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
  return checkPresence(value);
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
