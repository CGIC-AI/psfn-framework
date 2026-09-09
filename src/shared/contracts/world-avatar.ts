// ── World-avatar contract (S13 MOVE) ──
//
// The companion's own body in the Eidoverse world, reached gateway → Satellite
// Hub over the Hub's private control port (`POST /internal/v1/world/*`, Hub
// control token). This is the COMPANION moving itself; it never involves a Hub
// device assertion. Mirrors `apps/satellite-hub/src/ts/shared/protocol.ts`
// (the Hub project cannot import framework source). Additive only.

interface WorldAvatarPosition {
  x: number;
  z: number;
}

interface WorldAvatarSelf {
  id: string;
  world: string;
  positionKnown: boolean;
  x?: number;
  z?: number;
  groundHeightM?: number;
  facing?: string;
}

interface WorldAvatarPerson {
  id: string;
  /**
   * Who this is, as the world classifies it: `ai` when the world tagged its
   * chat as agent-authored, `human` when it spoke untagged. Unknown
   * participants are ASSUMED ai (operator rule) with `kindSource: 'assumed'`.
   */
  kind?: 'human' | 'ai';
  kindSource?: 'world' | 'assumed';
  positionKnown: boolean;
  x?: number;
  z?: number;
  distanceM?: number;
  bearing?: string;
  doing?: string;
}

interface WorldAvatarThing {
  id: string;
  label: string;
  positionKnown: boolean;
  x?: number;
  y?: number;
  z?: number;
  distanceM?: number;
  bearing?: string;
  detail?: string;
}

export interface WorldAvatarPerception {
  world: string;
  placeId?: string;
  region?: string;
  capturedAt: string;
  self: WorldAvatarSelf | null;
  people: WorldAvatarPerson[];
  things: WorldAvatarThing[];
  recent: string[];
  raw: string;
}

export interface WorldAvatarMoveRequest {
  world?: string;
  region?: string;
  position?: WorldAvatarPosition;
  participant?: string;
  waitMs?: number;
}

type WorldAvatarWalkStatus = 'arrived' | 'walking' | 'interrupted' | 'failed' | 'already_there';

type WorldAvatarMoveRejectionReason =
  | 'not_configured'
  | 'unavailable'
  | 'invalid_world'
  | 'unmapped_world'
  | 'refused'
  | 'participant_unknown'
  | 'participant_position_unknown'
  | 'position_unknown';

interface WorldAvatarWalk {
  status: WorldAvatarWalkStatus;
  x?: number;
  z?: number;
  target?: WorldAvatarPosition;
}

export type WorldAvatarMoveOutcome =
  | { accepted: true; world: string; placeId?: string; walk?: WorldAvatarWalk }
  | { accepted: false; world: string; reason: WorldAvatarMoveRejectionReason };

/** Body and creation verbs the Hub allowlists; tiers decide which apply. */
export const WORLD_AVATAR_BODY_VERBS = ['face', 'stop', 'emote', 'posture', 'whisper'] as const;
export const WORLD_AVATAR_EDIT_VERBS = ['spawn', 'remove', 'set_avatar'] as const;
type WorldAvatarBodyVerb = (typeof WORLD_AVATAR_BODY_VERBS)[number];
export type WorldAvatarEditVerb = (typeof WORLD_AVATAR_EDIT_VERBS)[number];
export type WorldAvatarVerb = WorldAvatarBodyVerb | WorldAvatarEditVerb;

export function isWorldAvatarEditVerb(verb: string): verb is WorldAvatarEditVerb {
  return (WORLD_AVATAR_EDIT_VERBS as readonly string[]).includes(verb);
}

export function isWorldAvatarVerb(verb: string): verb is WorldAvatarVerb {
  return (WORLD_AVATAR_BODY_VERBS as readonly string[]).includes(verb) || isWorldAvatarEditVerb(verb);
}

interface WorldAvatarActRequest {
  verb: WorldAvatarVerb;
  arguments?: Record<string, unknown>;
}

export type WorldAvatarActOutcome =
  | { accepted: true; verb: string; outcome: string; reply: string | null }
  | { accepted: false; verb: string; reason: 'not_configured' | 'not_allowlisted' | 'unavailable' };
