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
//   * the Hub answers a perceive with no place named (a body, alive, right
//     now, wherever it is), and places.json knows that world: the entry the
//     Hub names, or the one whose eidoverse binding carries that world. The
//     tracker is not consulted: the world connector is enrolled at its place
//     rather than moved to it, and world turns never mark the tracker, so the
//     body's whereabouts come from the body itself;
//   * it is not quiet hours, the interval since the last invitation has
//     passed, and the per-day cap is not spent.
//
// Silence is a full answer: REFLECTION_SILENT_TOKEN ends the turn quietly.

import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { WorldOperations } from '../../../boundary/integrations/world/ops.js';
import { REFLECTION_SILENT_TOKEN } from '../../../core/scheduler/reflection-policy.js';
import { evaluateProactiveOutboundTimeGate, type ProactiveQuietHoursConfig } from '../../../core/intention/proactive-time-gate.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import { isEidoversePlace, type EidoversePlaceBinding, type PlaceConfig, type PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { WorldAvatarPerception } from '../../../shared/contracts/world-avatar.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { runWithChargeContext } from '../../../shared/telemetry/run-charge.js';
import type { ChargePolicyConfig } from '../../../shared/contracts/charge-policy.js';
import type { WorldExplorationConfig } from '../../../system/config/scheduler-config/world-exploration.js';
import type { CapabilityRuntime } from '../../../system/capabilities/runtime.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';

const log = createComponentLogger('WorldExplorationLane');

export const WORLD_EXPLORATION_TASK_ID = 'world-exploration:invite';
const WORLD_EXPLORATION_TASK_NAME = 'world-exploration';
/**
 * NOT an `internal:reflection:*` channel: that prefix resolves the task kind
 * `reflection`, and reflection turns get the maintenance-restricted tool set
 * (contact/identity/memory/session/self_status/system), which has no `world`
 * or `wiki` tool. An exploration turn is self-directed cognition that must be
 * able to perceive, move and act, like the social-outreach and free-time
 * lanes, so it carries a plain `internal:` channel of its own.
 */
export const WORLD_EXPLORATION_CHANNEL_ID = 'internal:world-exploration';
const MINUTE_MS = 60_000;
/** The scheduler tick that checks the gates; the real cadence is the interval. */
const CHECK_INTERVAL_MS = 5 * MINUTE_MS;

type WorldExplorationSkipReason =
  | 'disabled'
  | 'tier'
  | 'not_on_world_plane'
  | 'no_body'
  | 'quiet_hours'
  | 'interval'
  | 'daily_cap'
  /** The invitation was issued but the turn itself failed (provider, runtime); logged, never rethrown. */
  | 'turn_failed';

export interface WorldExplorationLaneDeps {
  scheduler: Pick<Scheduler, 'register'>;
  config: WorldExplorationConfig;
  quietHours: ProactiveQuietHoursConfig | null;
  agentLoop: Pick<SubstrateAgent, 'handleMessage'>;
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

function buildWorldExplorationPrompt(input: { world: string; placeLabel: string; people: number; things: number }): string {
  return [
    `You have a body in the world "${input.world}" right now, standing at ${input.placeLabel}, with nothing asked of you.`,
    `Around you: ${input.people === 0 ? 'nobody' : `${input.people} other${input.people === 1 ? '' : 's'}`}, ${input.things === 0 ? 'nothing placed' : `${input.things} placed thing${input.things === 1 ? '' : 's'}`}.`,
    '',
    'This is your own time there. If you feel like it: use the world tool to look around (perceive),',
    'walk somewhere you have not been (move to a place on this plane, a position, or a participant),',
    'greet someone with a wave or a gesture (act), and keep a note of',
    'anything worth remembering about this world (wiki world_note). Nothing here requires you to do',
    'or say anything.',
    '',
    `If you would rather stay as you are, reply with only "${REFLECTION_SILENT_TOKEN}".`,
  ].join('\n');
}

type EidoverseBoundPlace = PlaceConfig & { eidoverse: EidoversePlaceBinding };

function resolveWorldPlace(registry: PlacesRegistryConfig, perception: WorldAvatarPerception): EidoverseBoundPlace | undefined {
  const named = perception.placeId
    ? registry.places.find((candidate) => candidate.placeId === perception.placeId)
    : undefined;
  if (named && isEidoversePlace(named) && named.eidoverse.world === perception.world) return named;
  const bound = registry.places.find((candidate) => isEidoversePlace(candidate) && candidate.eidoverse.world === perception.world);
  return bound && isEidoversePlace(bound) ? bound : undefined;
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

    const nowMs = now();
    const gate = evaluateProactiveOutboundTimeGate({ nowMs, quietHours: deps.quietHours });
    if (!gate.allowed) return 'quiet_hours';
    if (lastInvitedAtMs !== undefined && nowMs - lastInvitedAtMs < deps.config.intervalMinutes * MINUTE_MS) return 'interval';
    const today = localDayKey(nowMs);
    if (today !== dayKey) { dayKey = today; turnsToday = 0; }
    if (turnsToday >= deps.config.maxTurnsPerDay) return 'daily_cap';

    // A body, alive, right now: the Hub must answer a perceive, wherever the body is.
    let perception: WorldAvatarPerception;
    try {
      if (!deps.worldOps.avatarPerceive) return 'no_body';
      perception = await deps.worldOps.avatarPerceive({});
    } catch (error) {
      log.debug('World exploration skipped: the Hub answered no body', { error: String(error) });
      return 'no_body';
    }
    // ...and the map must know the world it stands in: the place the Hub
    // named, else the registry entry bound to that world.
    const place = resolveWorldPlace(deps.placesRegistry, perception);
    if (!place) return 'not_on_world_plane';
    const people = perception.people.length;
    const things = perception.things.length;

    lastInvitedAtMs = nowMs;
    turnsToday += 1;
    const prompt = buildWorldExplorationPrompt({
      world: place.eidoverse.world,
      placeLabel: place.displayName || place.placeId,
      people,
      things,
    });
    const invite = async (): Promise<'invited' | 'silent' | 'turn_failed'> => {
      let response: { content: string };
      try {
        response = await deps.agentLoop.handleMessage({
          id: `world-exploration-${nowMs}`,
          channelId: WORLD_EXPLORATION_CHANNEL_ID,
          channelType: 'terminal',
          authorId: 'scheduler',
          authorName: WORLD_EXPLORATION_TASK_NAME,
          content: prompt,
          timestamp: new Date(nowMs),
        });
      } catch (error) {
        // The interval and the daily cap were already spent on this attempt:
        // a failing provider must not turn the lane into a retry loop.
        log.warn('World exploration turn failed', { error: String(error) });
        return 'turn_failed';
      }
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
