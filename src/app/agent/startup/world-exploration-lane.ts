// ── World exploration lane (S13, psfn-framework-07mw2) ──
//
// The companion's own initiative on a world plane: on its own schedule, an
// internal turn invites it to look around and, if it likes, walk somewhere,
// greet someone, or note what it found. Nothing here moves the body itself;
// the turn uses the ordinary world tool, so every move and act still crosses
// the gateway's world-autonomy limiter, the verb allowlist, and cogsec. The
// lane only decides WHETHER to invite, and only when all of these hold:
//
//   * the lane is enabled in scheduler.json (off by default);
//   * the companion's tier grants live world perception (`world.read`,
//     apprentice and up);
//   * the situated place is on a world plane (a places.json entry with an
//     eidoverse binding), and the Hub answers a perceive for that world
//     (a body, alive, right now);
//   * it is not quiet hours, the interval since the last invitation has
//     passed, and the per-day cap is not spent.
//
// Silence is a full answer: REFLECTION_SILENT_TOKEN ends the turn quietly.

import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { WorldOperations } from '../../../boundary/integrations/world/ops.js';
import { REFLECTION_SILENT_TOKEN } from '../../../core/scheduler/reflection-policy.js';
import { evaluateProactiveOutboundTimeGate, type ProactiveQuietHoursConfig } from '../../../core/intention/proactive-time-gate.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import { isEidoversePlace, type PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { runWithChargeContext } from '../../../shared/telemetry/run-charge.js';
import type { ChargePolicyConfig } from '../../../shared/contracts/charge-policy.js';
import type { WorldExplorationConfig } from '../../../system/config/scheduler-config/world-exploration.js';
import type { CapabilityRuntime } from '../../../system/capabilities/runtime.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';

const log = createComponentLogger('WorldExplorationLane');

export const WORLD_EXPLORATION_TASK_ID = 'world-exploration:invite';
export const WORLD_EXPLORATION_TASK_NAME = 'world-exploration';
export const WORLD_EXPLORATION_CHANNEL_ID = 'internal:reflection:world-exploration';
const MINUTE_MS = 60_000;
/** The scheduler tick that checks the gates; the real cadence is the interval. */
const CHECK_INTERVAL_MS = 5 * MINUTE_MS;

export type WorldExplorationSkipReason =
  | 'disabled'
  | 'tier'
  | 'not_on_world_plane'
  | 'no_body'
  | 'quiet_hours'
  | 'interval'
  | 'daily_cap';

export interface WorldExplorationLaneDeps {
  scheduler: Pick<Scheduler, 'register'>;
  config: WorldExplorationConfig;
  quietHours: ProactiveQuietHoursConfig | null;
  agentLoop: Pick<SubstrateAgent, 'handleMessage' | 'resolveCurrentSituatedPlaceId'>;
  placesRegistry: PlacesRegistryConfig;
  worldOps: Pick<WorldOperations, 'avatarPerceive'>;
  capabilityRuntime: Pick<CapabilityRuntime, 'has'>;
  eventBus: EventBus;
  chargePolicy: ChargePolicyConfig | undefined;
  now?: () => number;
}

export interface WorldExplorationLane {
  /** Run one gate check now; returns why it skipped, or `invited`. Exposed for tests and operators. */
  runOnce(): Promise<WorldExplorationSkipReason | 'invited' | 'silent'>;
}

export function buildWorldExplorationPrompt(input: { world: string; placeLabel: string; people: number; things: number }): string {
  return [
    `You have a body in the world "${input.world}" right now, standing at ${input.placeLabel}, with nothing asked of you.`,
    `Around you: ${input.people === 0 ? 'nobody' : `${input.people} other${input.people === 1 ? '' : 's'}`}, ${input.things === 0 ? 'nothing placed' : `${input.things} placed thing${input.things === 1 ? '' : 's'}`}.`,
    '',
    'This is your own time there. If you feel like it: use the world tool to look around (perceive),',
    'walk somewhere you have not been (move to a place on this plane, a position, or a participant),',
    'greet someone with a wave or a word (act, or say hello in the world channel), and keep a note of',
    'anything worth remembering about this world (wiki world_note). Nothing here requires you to do',
    'or say anything.',
    '',
    `If you would rather stay as you are, reply with only "${REFLECTION_SILENT_TOKEN}".`,
  ].join('\n');
}

export function registerWorldExplorationLane(deps: WorldExplorationLaneDeps): WorldExplorationLane {
  const now = deps.now ?? (() => Date.now());
  let lastInvitedAtMs: number | undefined;
  let dayKey = '';
  let turnsToday = 0;

  const localDayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  const runOnce = async (): Promise<WorldExplorationSkipReason | 'invited' | 'silent'> => {
    if (!deps.config.enabled) return 'disabled';
    if (!deps.capabilityRuntime.has('world.read')) return 'tier';
    const placeId = deps.agentLoop.resolveCurrentSituatedPlaceId();
    const place = placeId ? deps.placesRegistry.places.find((candidate) => candidate.placeId === placeId) : undefined;
    if (!place || !isEidoversePlace(place)) return 'not_on_world_plane';

    const nowMs = now();
    const gate = evaluateProactiveOutboundTimeGate({ nowMs, quietHours: deps.quietHours });
    if (!gate.allowed) return 'quiet_hours';
    if (lastInvitedAtMs !== undefined && nowMs - lastInvitedAtMs < deps.config.intervalMinutes * MINUTE_MS) return 'interval';
    const today = localDayKey(nowMs);
    if (today !== dayKey) { dayKey = today; turnsToday = 0; }
    if (turnsToday >= deps.config.maxTurnsPerDay) return 'daily_cap';

    // A body, alive, right now: the Hub must answer a perceive for this world.
    let people = 0;
    let things = 0;
    try {
      if (!deps.worldOps.avatarPerceive) return 'no_body';
      const perception = await deps.worldOps.avatarPerceive({ placeId: place.placeId });
      if (perception.world !== place.eidoverse.world) return 'no_body';
      people = perception.people.length;
      things = perception.things.length;
    } catch (error) {
      log.debug('World exploration skipped: the Hub answered no body', { error: String(error) });
      return 'no_body';
    }

    lastInvitedAtMs = nowMs;
    turnsToday += 1;
    const prompt = buildWorldExplorationPrompt({
      world: place.eidoverse.world,
      placeLabel: place.displayName || place.placeId,
      people,
      things,
    });
    const invite = async (): Promise<'invited' | 'silent'> => {
      const response = await deps.agentLoop.handleMessage({
        id: `reflection-world-exploration-${nowMs}`,
        channelId: WORLD_EXPLORATION_CHANNEL_ID,
        channelType: 'terminal',
        authorId: 'scheduler',
        authorName: WORLD_EXPLORATION_TASK_NAME,
        content: prompt,
        timestamp: new Date(nowMs),
      });
      const trimmed = response.content.trim();
      const silent = !trimmed || trimmed.toLowerCase() === REFLECTION_SILENT_TOKEN.toLowerCase();
      return silent ? 'silent' : 'invited';
    };
    if (!deps.chargePolicy) return invite();
    return runWithChargeContext({
      chargePolicy: deps.chargePolicy,
      eventBus: deps.eventBus,
      lane: 'background',
      correlation: getRequestContext(),
    }, invite);
  };

  deps.scheduler.register({
    id: WORLD_EXPLORATION_TASK_ID,
    name: WORLD_EXPLORATION_TASK_NAME,
    description: 'Invites the companion to explore the world it has a body in, on its own schedule.',
    type: 'every',
    intervalMs: CHECK_INTERVAL_MS,
    state: 'idle',
    handler: async () => {
      const outcome = await runOnce();
      if (outcome === 'invited' || outcome === 'silent') {
        log.info('World exploration turn ran', { outcome });
      }
    },
  });

  return { runOnce };
}
