import { z } from 'zod';
// Team workspaces: routing policies, member availability and update pushes.

export const routingStates = ['routing', 'claimed', 'exhausted', 'ended'] as const;
/** `routing`: notifying levels; `exhausted`: every level and repeat passed, open until it expires. */
export type RoutingState = (typeof routingStates)[number];
export const routingModes = ['notify_all', 'round_robin'] as const;
const member = z.string().min(1).max(200);
/**
 * One escalation level. `round_robin` notifies the available member assigned longest ago;
 * `onTimeout: 'next_member'` tries each of the level's members once before escalating.
 */
export const routingLevelSchema = z
  .object({
    targets: z.union([z.literal('all'), z.array(member).min(1).max(100)]),
    mode: z.enum(routingModes),
    /** Seconds before the level times out. */
    timeout: z.number().int().min(60).max(86_400),
    onTimeout: z.enum(['escalate', 'next_member']).default('escalate'),
  })
  .strict()
  .refine(
    (l) =>
      !(l.mode === 'notify_all' && (l.targets === 'all' || l.targets.length > 1)) ||
      l.timeout >= 180,
    'Notifying several members needs a timeout of at least 3 minutes.',
  )
  .refine(
    (l) => l.onTimeout === 'escalate' || l.mode === 'round_robin',
    'Only round robin levels can move to the next member.',
  );
export type RoutingLevel = z.infer<typeof routingLevelSchema>;
/** A team's escalation policy; requests snapshot it when they are created. */
export const routingPolicySchema = z
  .object({
    levels: z.array(routingLevelSchema).min(1).max(5),
    /** Times the levels run again after the last one. */
    repeat: z.number().int().min(0).max(3).default(0),
  })
  .strict()
  .refine(
    (p) => p.levels.reduce((sum, l) => sum + l.timeout, 0) * (p.repeat + 1) <= 86_400,
    'A policy runs for at most 24 hours.',
  );
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;
export type RoutingPolicyInput = z.input<typeof routingPolicySchema>;
/** `PUT /members/me/availability`: away members are skipped by routing. */
export const memberAvailabilitySchema = z
  .object({ away: z.boolean(), until: z.string().datetime().optional() })
  .strict();
export type MemberAvailability = z.infer<typeof memberAvailabilitySchema>;
/** Pushes for one-way updates in a team: every one, the routing policy's targets, or none. */
export const updatePushes = ['always', 'policy', 'never'] as const;
export const teamPreferencesSchema = z.object({ updates: z.enum(updatePushes) }).strict();
export type TeamPreferences = z.infer<typeof teamPreferencesSchema>;
