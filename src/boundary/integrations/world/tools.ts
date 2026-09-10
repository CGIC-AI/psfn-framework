import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../../core/agent/tool-surface/descriptions.js';
import type { AgentToolResult } from '../../pi-agent/index.js';
import type { SubstrateAgentTool } from '../../pi-agent/index.js';
import {
  isEidoversePlace,
  type AffordanceConfig,
  type PlaceConfig,
  type PlacesRegistryConfig,
} from '../../../shared/contracts/places-registry.js';
import {
  WORLD_AVATAR_BODY_VERBS,
  WORLD_AVATAR_EDIT_VERBS,
  isWorldAvatarEditVerb,
  isWorldAvatarVerb,
  type WorldAvatarMoveOutcome,
  type WorldAvatarPerception,
} from '../../../shared/contracts/world-avatar.js';
import type { CompanionPresenceTurnPort } from '../../../core/agent/companion-presence-runtime.js';
import type { SituatedPlaceRef } from '../../../core/agent/substrate-agent/runtime-context-sections/situated-presence.js';
import {
  composeRoomEntryNote,
  ROOM_ENTRY_NOTE_SOURCE,
  type RoomEntryNoteSink,
  type RoomEntryOccupant,
} from '../../../core/session/room-entry-note.js';
import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { isHighTierTrustLevel, type TrustLevel } from '../../../system/trust/types.js';
import type { RequesterProvenance } from '../../../shared/contracts/runtime.js';
import type { WorldOperations } from './ops.js';
import type { WorldPlaneMapCache } from '../../../shared/contracts/world-plane-map.js';

// ── Agent-side `world` tool (Sprint 10, Workstream C2 + C3/C4) ──
//
// One action-dispatched tool over the physical/virtual world. Actions:
//   perceive  — read Home-Assistant states for a place's affordances + summary
//   list      — enumerate affordances for a place (default) or the whole site;
//               on a world plane, also the world's own map (hub-mapped
//               places, the current room, terrain) and the door's tool list
//   control   — call an HA service on an effector affordance
//   move      — deliberate self-invoked navigation (vinz.26, s10wm): a virtual
//               place, or — S13 MOVE — the companion's own Eidoverse BODY:
//               travel when the place is in another world, walk when it is a
//               position in the current one, or walk to a participant
//   act       — Eidoverse body verbs (face/stop/emote/posture) and, at the
//               control tier, creation verbs (spawn/remove/set_avatar)
//
// The Eidoverse is a PLANE of the same map: a place whose registry entry
// carries an `eidoverse` binding is somewhere the body can go. Moving there
// goes gateway → Satellite Hub control port → door, authenticated by the
// gateway's Hub control key alone; no Hub device assertion is ever involved
// on the companion's own path (that door is for external devices).
//
// Affordance → entity resolution happens HERE, agent-side, against `places.json`
// (defence in depth): the gateway only ever receives an `entity_id`/`service`
// this tool proved is in the registry. An `affordanceId`/`placeId` absent from
// the registry is rejected BEFORE any RPC crosses to the gateway.
//
// `move` (contract s10wm): virtual places only. Physical places are NOT movable
// by tool call — satellites are static and physical presence is
// emanation-driven via the sensor bridge (locations decisions 6/12) — so a
// physical destination fails closed with an explain-why error. Presence is
// written EXCLUSIVELY through `CompanionPresenceTurnPort.recordDeliberateMove`
// (never the shared `companion_presence` table/store directly) so co-location
// events, the situated "Here:" block, and the wiki shared-scope swap all follow
// from that single seam. Flag-off (single-companion, no port wired) a move is
// LOCAL-ONLY: the situated overlay updates, no shared-table write happens.
//
// Control gating (bead vinz.10) — three independent, fail-closed gates guard
// `action=control`; perceive/list — and `move`, which gates read-tier like
// them, NOT like control — are unaffected:
//   1. Capability token `world.control` — enforced OUTSIDE this tool by the
//      capability gate (see resolveWorldRequirement). Only autonomous and an
//      explicitly configured custom tier can surface control.
//   2. Runtime master gate `WORLD_CONTROL_RUNTIME_ENABLED`; an embedding may
//      override it to false as an emergency stop without disabling perception.
//   3. Requester provenance + trust. All callers need primary/trusted scope.
//      Self-directed/system turns additionally need a recognized intent and
//      audit reason and are restricted to registered light affordances.

const WORLD_ACTION_HELP = 'perceive, list, control, move, act';

/**
 * Runtime master gate for effector actuation. Capability and gateway policy
 * remain independent fail-closed controls; read paths are unaffected.
 */
export const WORLD_CONTROL_RUNTIME_ENABLED = true;

type WorldAction = 'perceive' | 'list' | 'control' | 'move' | 'act';
type WorldCommand = 'on' | 'off' | 'toggle';
type WorldControlIntent = 'direct' | 'presence_enter' | 'presence_exit' | 'attention' | 'sleep' | 'wake';

const COMMAND_TO_SERVICE: Readonly<Record<WorldCommand, string>> = Object.freeze({
  on: 'turn_on',
  off: 'turn_off',
  toggle: 'toggle',
});

export interface WorldToolParams {
  action?: WorldAction;
  placeId?: string;
  affordanceId?: string;
  command?: WorldCommand;
  intent?: WorldControlIntent;
  reason?: string;
  scope?: 'place' | 'site';
  data?: Record<string, unknown>;
  /** move: walk to this in-world participant (id as shown before their messages). */
  participant?: string;
  /** move: walk to this ground-plane position in the current world. */
  position?: { x: number; z: number };
  /** act: the Eidoverse body or creation verb. */
  verb?: string;
  /** act: verb arguments (face: target|x,z; emote: name; posture: kind; spawn: query|lib,x,z; remove: id; set_avatar: avatar). */
  arguments?: Record<string, unknown>;
}

export interface WorldToolDeps {
  /** Places soft-registry (`places.json`). Empty registry ⇒ no resolvable affordances. */
  placesRegistry: PlacesRegistryConfig;
  /**
   * Resolves the companion's current situated `placeId` for deictic defaults
   * ("dim the lights"). Supplied by the situated/emanation runtime; optional —
   * without it, perceive/list default to explicit `placeId` or site-wide.
   */
  resolveSituatedPlaceId?: () => string | undefined;
  /**
   * Per-world map the world publishes at runtime (psfn-framework-gs899,
   * g8xyn). `list` refreshes it on a world plane and `perceive` folds the
   * room into it; the situated block reads it. Optional: unwired ⇒ `list`
   * reports the registry alone and a hub-only place cannot be moved to.
   */
  worldPlaneMap?: WorldPlaneMapCache;
  /**
   * Cross-companion presence turn port (multi-companion, W5a). `move` writes
   * presence through THIS seam only — never a store/table directly (contract
   * s10wm). Null/absent = flag-off: a move is local-only (no shared write).
   */
  companionPresence?: CompanionPresenceTurnPort | null;
  /**
   * Applies a deliberate virtual move to the LOCAL situated state (the
   * emanation tracker's virtual overlay) so the next turn's situated block and
   * wiki scope foreground the destination. Required for `move`; when unwired
   * the action fails closed (no silent partial move).
   */
  applyVirtualMove?: (placeId: string) => void;
  /**
   * Bounded device health for a physical place (bead psfn-framework-s7wq3).
   * Returns `ok`/`degraded` only where a satellite heartbeat has actually been
   * observed, and `undefined` otherwise — so this annotates the emanation
   * choice without adding a badge to every place or any new prompt surface.
   * Unwired ⇒ the field never appears.
   */
  resolvePlaceDeviceStatus?: (placeId: string) => 'ok' | 'degraded' | undefined;
  /**
   * Context-system-note lane for the room-entry note (W5 entry event). The note
   * is delivered into the session channel the move was invoked from (resolved
   * off the turn's request context). Optional: unwired ⇒ the result reports the
   * note as skipped rather than silently pretending it fired.
   */
  roomEntryNoteSink?: RoomEntryNoteSink;
  /**
   * Staged-off gate for `action=control`. Defaults to
   * `WORLD_CONTROL_RUNTIME_ENABLED` (false). When false, control refuses
   * fail-closed; perceive/list/move stay live.
   */
  controlEnabled?: boolean;
  /**
   * Resolves the current requester's trust level for the turn (owner/partner =
   * primary/trusted). Supplied at runtime from the turn request context
   * (`viewerTrustLevel`). Absent or non-high-tier ⇒ control is refused.
   */
  resolveRequesterTrust?: () => TrustLevel | undefined;
  /**
   * Resolves the current requester's PROVENANCE (human vs machine/self-directed),
   * orthogonal to trust level. Supplied at runtime from the turn request context
   * (`requesterProvenance`). Human-in-the-loop effector control (Gate 2) requires
   * `'human'`; self-directed/system turns are refused even when trust is 'primary'.
   * Fail closed: absent ⇒ treated as non-human ⇒ control is refused.
   */
  resolveRequesterProvenance?: () => RequesterProvenance | undefined;
  /**
   * Allows a reasoned, non-human shard request to cross this agent-side trust
   * gate only as transport to the gateway's exact operator-approval fence.
   * It does not authorize the effect and must be scoped from trusted runtime
   * context, never tool parameters.
   */
  allowRequestScopedApprovalTransport?: () => boolean;
}

interface ResolvedAffordance {
  place: PlaceConfig;
  affordance: AffordanceConfig;
}

function normalizeWorldAction(params: WorldToolParams): WorldAction {
  const raw = typeof params.action === 'string' ? params.action.trim() : '';
  if (raw === 'perceive' || raw === 'list' || raw === 'control' || raw === 'move' || raw === 'act') {
    return raw;
  }
  if (!raw) {
    throw new Error(`action is required. Supported actions: ${WORLD_ACTION_HELP}`);
  }
  throw new Error(`action must be one of: ${WORLD_ACTION_HELP}`);
}

function requirePlainString(
  params: WorldToolParams,
  key: 'placeId' | 'affordanceId',
  action: WorldAction,
  example: string,
): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `action=${action} requires ${key} as a plain non-empty string. Example: ${example}.`,
    );
  }
  return value.trim();
}

function resolvePlace(registry: PlacesRegistryConfig, placeId: string): PlaceConfig {
  const place = registry.places.find((entry) => entry.placeId === placeId);
  if (!place) {
    throw new Error(`placeId "${placeId}" is not in places.json`);
  }
  return place;
}

function resolveAffordance(
  registry: PlacesRegistryConfig,
  affordanceId: string,
  placeId?: string,
): ResolvedAffordance {
  const places = placeId ? [resolvePlace(registry, placeId)] : registry.places;
  for (const place of places) {
    const affordance = place.affordances.find((entry) => entry.affordanceId === affordanceId);
    if (affordance) {
      return { place, affordance };
    }
  }
  const scope = placeId ? ` in place "${placeId}"` : '';
  throw new Error(`affordanceId "${affordanceId}" is not in places.json${scope}`);
}

function describeAffordance(place: PlaceConfig, affordance: AffordanceConfig): Record<string, unknown> {
  return {
    affordanceId: affordance.affordanceId,
    placeId: place.placeId,
    kind: affordance.kind,
    role: affordance.role,
    backend: affordance.backend,
    ...(affordance.displayName ? { displayName: affordance.displayName } : {}),
    ...(affordance.entityId ? { entityId: affordance.entityId } : {}),
    ...(affordance.control ? { control: affordance.control } : {}),
    controllable: affordance.role === 'effector' && affordance.backend === 'ha' && Boolean(affordance.entityId),
  };
}

async function runPerceive(
  ops: WorldOperations,
  deps: WorldToolDeps,
  params: WorldToolParams,
): Promise<string> {
  const placeId = (typeof params.placeId === 'string' && params.placeId.trim())
    || deps.resolveSituatedPlaceId?.();
  if (!placeId) {
    throw new Error(
      'action=perceive requires a place: pass placeId, or emanate into a place so the situated default resolves.',
    );
  }
  const place = resolvePlace(deps.placesRegistry, placeId);
  const haAffordances = place.affordances.filter(
    (affordance) => affordance.backend === 'ha' && Boolean(affordance.entityId),
  );

  // Eidoverse plane: the 3D scene as the body sees it, in the same shape the
  // physical places report their affordances. Honest about presence: when
  // the body is in another world than the place asks about, say so.
  let avatar: Record<string, unknown> | undefined;
  if (isEidoversePlace(place)) {
    const perception = await requireAvatarOps(ops, 'avatarPerceive')({ placeId: place.placeId });
    deps.worldPlaneMap?.rememberRoom(perception.world, perception.room, perception.capturedAt);
    avatar = describeAvatarPerception(perception, place);
  }

  const readings: Array<Record<string, unknown>> = [];
  for (const affordance of haAffordances) {
    const entityId = affordance.entityId as string;
    const result = await ops.getStates({ entityId });
    const state = result.states.length > 0 ? result.states[0] : undefined;
    readings.push({
      affordanceId: affordance.affordanceId,
      kind: affordance.kind,
      role: affordance.role,
      entityId,
      ...(affordance.displayName ? { displayName: affordance.displayName } : {}),
      state: state?.state ?? 'unknown',
      ...(state?.attributes ? { attributes: state.attributes } : {}),
    });
  }

  const haSummary = readings.length === 0
    ? (avatar ? '' : `${place.displayName}: no Home-Assistant-backed affordances configured.`)
    : `${place.displayName}: ${readings.map((r) => `${r.displayName ?? r.affordanceId}=${r.state}`).join(', ')}.`;
  const summary = [avatar?.summary as string | undefined, haSummary].filter(Boolean).join(' ');

  return JSON.stringify({
    action: 'perceive',
    placeId: place.placeId,
    place: place.displayName,
    ...(avatar ? { eidoverse: avatar } : {}),
    readings,
    summary,
  }, null, 2);
}

type AvatarOpName = 'avatarPerceive' | 'avatarMap' | 'avatarMove' | 'avatarAct';

/** The avatar ops are optional on the port; an Eidoverse place with none wired fails closed. */
function requireAvatarOps<K extends AvatarOpName>(ops: WorldOperations, key: K): NonNullable<WorldOperations[K]> {
  const op = ops[key];
  if (!op) {
    throw new Error(
      'the Eidoverse body is not reachable in this runtime (no Satellite Hub world transport is wired: '
      + 'set SATELLITE_HUB_CONTROL_BASE_URL and SATELLITE_HUB_CONTROL_TOKEN on the gateway).',
    );
  }
  return op.bind(ops) as NonNullable<WorldOperations[K]>;
}

function describeAvatarPerception(
  perception: WorldAvatarPerception,
  place: PlaceConfig & { eidoverse: NonNullable<PlaceConfig['eidoverse']> },
): Record<string, unknown> {
  const present = perception.world === place.eidoverse.world;
  const self = perception.self;
  const me = self?.positionKnown && self.x !== undefined && self.z !== undefined
    ? `You are at (${self.x}, ${self.z})${self.facing ? ` facing ${self.facing}` : ''}`
    : 'Your own position is unknown right now';
  const people = perception.people.length === 0
    ? 'Nobody else is here.'
    : `Here with you: ${perception.people.map((person) => (
      (person.positionKnown && person.x !== undefined
        ? `${person.id} at (${person.x}, ${person.z})${person.distanceM !== undefined ? `, ${person.distanceM}m ${person.bearing ?? ''}`.trimEnd() : ''}${person.doing ? `, ${person.doing}` : ''}`
        : `${person.id} (position unknown)`)
        + (person.kind === 'human' ? ' [human]' : person.kind === 'ai' ? (person.kindSource === 'assumed' ? ' [AI, assumed]' : ' [AI]') : '')
    )).join('; ')}.`;
  const things = perception.things.length === 0
    ? 'Nothing placed nearby.'
    : `Things: ${perception.things.map((thing) => (
      thing.positionKnown && thing.x !== undefined
        ? `[${thing.id}] ${thing.label} at (${thing.x}, ${thing.z})`
        : `[${thing.id}] ${thing.label}`
    )).join('; ')}.`;
  const where = present
    ? `in world "${perception.world}"`
    : `NOTE: your body is in world "${perception.world}", not "${place.eidoverse.world}" (move there first)`;
  const room = perception.room
    ? ` You are in ${perception.room.labelled ? `the ${perception.room.label}` : `an unnamed room (${perception.room.label})`}${
      perception.room.sealed ? ' (sealed)' : perception.room.waysOut.length > 0 ? `; ways out: ${perception.room.waysOut.join('; ')}` : ''
    }.`
    : '';
  return {
    world: perception.world,
    present,
    ...(perception.placeId ? { bodyPlaceId: perception.placeId } : {}),
    ...(perception.room ? { room: perception.room } : {}),
    self,
    people: perception.people,
    things: perception.things,
    recent: perception.recent,
    capturedAt: perception.capturedAt,
    summary: `${me} ${where}.${room} ${people} ${things}`,
  };
}

async function runList(ops: WorldOperations, deps: WorldToolDeps, params: WorldToolParams): Promise<string> {
  const explicitPlaceId = typeof params.placeId === 'string' && params.placeId.trim()
    ? params.placeId.trim()
    : undefined;
  const siteWide = params.scope === 'site';
  const targetPlaceId = explicitPlaceId
    ?? (siteWide ? undefined : deps.resolveSituatedPlaceId?.());

  const places = targetPlaceId
    ? [resolvePlace(deps.placesRegistry, targetPlaceId)]
    : deps.placesRegistry.places;

  // World plane (gs899, g8xyn): when the list is about a world place — the
  // explicit one, or the situated one — ask the world for its own map and
  // the door's tools. Hub-published places the registry lacks are listed as
  // movable by id; the tool list is advisory (the verb allowlist decides).
  const planeAnchorId = targetPlaceId ?? deps.resolveSituatedPlaceId?.();
  const planeAnchor = planeAnchorId
    ? deps.placesRegistry.places.find((candidate) => candidate.placeId === planeAnchorId)
    : undefined;
  let worldPlane: Record<string, unknown> | undefined;
  if (planeAnchor && isEidoversePlace(planeAnchor) && ops.avatarMap) {
    try {
      const map = await ops.avatarMap({ placeId: planeAnchor.placeId });
      const snapshot = deps.worldPlaneMap?.remember(map);
      const known = new Set(places.map((place) => place.placeId));
      const hubOnly = map.places.filter((place) => !known.has(place.placeId)
        && !deps.placesRegistry.places.some((candidate) => candidate.placeId === place.placeId));
      worldPlane = {
        world: map.world,
        ...(map.placeId ? { placeId: map.placeId } : {}),
        ...(map.room ? { room: map.room } : {}),
        ...(map.terrain ? { terrain: map.terrain } : {}),
        hubPlaces: hubOnly.map((place) => ({ placeId: place.placeId, ...(place.region ? { region: place.region } : {}), movable: true, source: 'world' })),
        tools: (snapshot?.tools ?? map.tools).map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })),
        toolsNote: 'advisory: the world advertises these; you reach them through this tool\'s perceive/move/act verbs, and the verb allowlist decides what your body may do',
        capturedAt: map.capturedAt,
      };
    } catch (error) {
      worldPlane = { world: planeAnchor.eidoverse.world, unavailable: toErrorMessage(error) };
    }
  }

  return JSON.stringify({
    action: 'list',
    scope: targetPlaceId ? 'place' : 'site',
    places: places.map((place) => ({
      placeId: place.placeId,
      displayName: place.displayName,
      kind: place.kind,
      ...(place.eidoverse ? { eidoverse: place.eidoverse, movable: true } : {}),
      ...describeDeviceStatus(deps, place),
      affordances: place.affordances.map((affordance) => describeAffordance(place, affordance)),
    })),
    ...(worldPlane ? { worldPlane } : {}),
  }, null, 2);
}

async function runControl(
  ops: WorldOperations,
  deps: WorldToolDeps,
  params: WorldToolParams,
): Promise<string> {
  // Gate 1 — runtime master switch. Fail closed while off.
  const controlEnabled = deps.controlEnabled ?? WORLD_CONTROL_RUNTIME_ENABLED;
  if (!controlEnabled) {
    throw new Error(
      'world control is staged off: effector actuation is disabled until proven end-to-end. '
      + 'Perceive and list remain available. Enabling requires flipping WORLD_CONTROL_RUNTIME_ENABLED '
      + 'and granting the world.control capability token to the operating tier.',
    );
  }

  const requesterProvenance = deps.resolveRequesterProvenance?.();
  if (!requesterProvenance) {
    throw new Error('world control requires known requester provenance.');
  }
  const intent = params.intent ?? (requesterProvenance === 'human' ? 'direct' : undefined);
  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (requesterProvenance !== 'human' && (!intent || !reason)) {
    throw new Error(
      `autonomous world control from "${requesterProvenance}" requires explicit intent and reason.`,
    );
  }

  // Gate 2b — requester trust. Only primary/trusted (owner/partner) drive effectors.
  const requesterTrust = deps.resolveRequesterTrust?.();
  const requestScopedApprovalTransport = requesterProvenance !== 'human'
    && deps.allowRequestScopedApprovalTransport?.() === true;
  if ((!requesterTrust || !isHighTierTrustLevel(requesterTrust))
    && !requestScopedApprovalTransport) {
    const observed = requesterTrust ?? 'unknown';
    throw new Error(
      `world control requires a primary or trusted requester; the current requester is "${observed}". `
      + 'Effector actuation is refused for regular/public requesters.',
    );
  }

  const affordanceId = requirePlainString(params, 'affordanceId', 'control', 'lr_lights');
  const placeId = typeof params.placeId === 'string' && params.placeId.trim()
    ? params.placeId.trim()
    : undefined;
  // Agent-side registry check happens BEFORE any RPC (defence in depth).
  const { place, affordance } = resolveAffordance(deps.placesRegistry, affordanceId, placeId);

  if (affordance.role !== 'effector') {
    throw new Error(`affordance "${affordanceId}" is a ${affordance.role}, not a controllable effector.`);
  }
  if (affordance.backend !== 'ha') {
    throw new Error(
      `affordance "${affordanceId}" has backend "${affordance.backend}"; only Home-Assistant-backed control is supported (virtual/satellite control is future work).`,
    );
  }
  const entityId = affordance.entityId;
  if (!entityId) {
    throw new Error(`affordance "${affordanceId}" has no entityId binding in places.json.`);
  }

  const command = params.command;
  if (command !== 'on' && command !== 'off' && command !== 'toggle') {
    throw new Error('action=control requires command as one of: on, off, toggle.');
  }
  // Per-affordance allowlist: when the affordance declares a `control` list,
  // the requested command must be in it (fail-closed, defence in depth).
  if (affordance.control && !affordance.control.includes(command)) {
    throw new Error(
      `command "${command}" is not permitted for affordance "${affordanceId}"; `
      + `allowed: ${affordance.control.join(', ')}.`,
    );
  }
  const service = COMMAND_TO_SERVICE[command];
  const domain = entityId.split('.')[0] ?? '';

  if (requesterProvenance !== 'human' && affordance.kind !== 'light') {
    throw new Error('autonomous world control is limited to registered light affordances.');
  }

  const response = await ops.callService({
    domain,
    service,
    placeId: place.placeId,
    affordanceId,
    reason: reason || 'Direct request from a trusted human',
    ...(intent ? { intent } : {}),
    entityId,
    ...(params.data ? { data: params.data } : {}),
  });

  return JSON.stringify({
    action: 'control',
    affordanceId,
    placeId: place.placeId,
    entityId,
    command,
    domain,
    service,
    response: response.response ?? null,
  }, null, 2);
}

/**
 * v1 "exits" model (documented choice): `places.json` models no adjacency —
 * `PlaceConfig` carries no links/exits — so the natural walkable graph is the
 * SITE: every other place in the destination's site is an exit. Physical
 * sibling places are listed too (they exist in the world) but are annotated
 * with their kind; a `move` to them fails closed, so the model can see them
 * without being able to walk there.
 */
function listExits(
  registry: PlacesRegistryConfig,
  destination: PlaceConfig,
  deps: WorldToolDeps,
): Array<Record<string, unknown>> {
  return registry.places
    .filter((place) => place.siteId === destination.siteId && place.placeId !== destination.placeId)
    .map((place) => ({
      placeId: place.placeId,
      displayName: place.displayName,
      kind: place.kind,
      movable: place.kind === 'virtual' || isEidoversePlace(place),
      ...(place.eidoverse ? { eidoverse: place.eidoverse } : {}),
      ...describeDeviceStatus(deps, place),
    }));
}

/**
 * Emanation-time device status for one place. Physical places only: a virtual
 * place has no device to be degraded. Absent observation renders nothing.
 */
function describeDeviceStatus(
  deps: WorldToolDeps,
  place: PlaceConfig,
): { deviceStatus?: 'ok' | 'degraded' } {
  if (place.kind !== 'physical') return {};
  const status = deps.resolvePlaceDeviceStatus?.(place.placeId);
  return status ? { deviceStatus: status } : {};
}

/** Resolve the invoking turn's session channel from the ambient request context. */
function resolveInvokingChannelId(): string | undefined {
  const channelId = getRequestContext()?.channelId;
  if (typeof channelId !== 'string') return undefined;
  const trimmed = channelId.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * A move inside the world the body is in (to a participant or a position):
 * no registry place changes hands, so no presence write — the Hub reports
 * where the body ended up and which mapped place that is.
 */
async function runBodyMove(
  ops: WorldOperations,
  params: WorldToolParams,
): Promise<string> {
  const participant = typeof params.participant === 'string' ? params.participant.trim() : '';
  const position = params.position as unknown;
  if (position !== undefined && (typeof position !== 'object' || position === null
    || !Number.isFinite((position as { x?: unknown }).x) || !Number.isFinite((position as { z?: unknown }).z))) {
    throw new Error('action=move position must be an object with finite x and z.');
  }
  const target = position as { x: number; z: number } | undefined;
  const outcome = await requireAvatarOps(ops, 'avatarMove')({
    ...(participant ? { participant } : {}),
    ...(target ? { position: { x: target.x, z: target.z } } : {}),
  });
  return JSON.stringify({
    action: 'move',
    target: participant ? { participant } : { position: target },
    ...describeMoveOutcome(outcome),
  }, null, 2);
}

function describeMoveOutcome(outcome: WorldAvatarMoveOutcome): Record<string, unknown> {
  if (!outcome.accepted) {
    return {
      accepted: false,
      world: outcome.world,
      reason: outcome.reason,
      summary: `The world refused the move (${outcome.reason}); your body is still in "${outcome.world}".`,
    };
  }
  const walk = outcome.walk;
  const walkText = !walk
    ? `Your body is in world "${outcome.world}".`
    : walk.status === 'arrived'
      ? `Your body arrived at (${walk.x}, ${walk.z}) in world "${outcome.world}".`
      : walk.status === 'already_there'
        ? `You are already there, at (${walk.x}, ${walk.z}).`
        : walk.status === 'walking'
          ? `Your body is walking to (${walk.target?.x}, ${walk.target?.z}) in world "${outcome.world}"; arrival is reported on a later turn.`
          : walk.status === 'interrupted'
            ? 'The walk was interrupted or timed out before arrival.'
            : walk.status === 'no_position'
              ? `That region is mapped to a place but has no coordinates, so your body did not walk; give a position or a participant to walk to.`
              : 'The walk could not be carried out.';
  return {
    accepted: true,
    world: outcome.world,
    ...(outcome.placeId ? { bodyPlaceId: outcome.placeId } : {}),
    ...(walk ? { walk } : {}),
    summary: walkText,
  };
}

async function runMove(ops: WorldOperations, deps: WorldToolDeps, params: WorldToolParams): Promise<string> {
  const hasPlace = typeof params.placeId === 'string' && params.placeId.trim().length > 0;
  if (!hasPlace && (params.participant || params.position)) {
    return runBodyMove(ops, params);
  }
  const placeId = requirePlainString(params, 'placeId', 'move', 'place.mud-tavern');
  // A place the world published but places.json does not know (gs899): the
  // body walks there by region; nothing is written into the registry or the
  // local situated overlay (the next world turn carries its own place).
  const hubPlace = deps.placesRegistry.places.some((candidate) => candidate.placeId === placeId)
    ? undefined
    : deps.worldPlaneMap?.findPlace(placeId);
  if (hubPlace) {
    const outcome = await requireAvatarOps(ops, 'avatarMove')({
      placeId: hubPlace.placeId,
      world: hubPlace.world,
      ...(hubPlace.region ? { region: hubPlace.region } : {}),
      ...(params.participant ? { participant: params.participant.trim() } : {}),
    });
    if (!outcome.accepted) {
      throw new Error(
        `the world refused the move to "${placeId}" (${outcome.reason}); your body is still in "${outcome.world}".`,
      );
    }
    return JSON.stringify({
      action: 'move',
      placeId: hubPlace.placeId,
      source: 'world',
      body: describeMoveOutcome(outcome),
      note: 'this place comes from the world\'s own map, not places.json; no local presence overlay was written',
    }, null, 2);
  }
  // Fail closed: unknown destination never moves anything.
  const place = resolvePlace(deps.placesRegistry, placeId);
  if (place.kind === 'physical' && !isEidoversePlace(place)) {
    throw new Error(
      `cannot move to "${placeId}": it is a physical place. Physical presence is `
      + 'emanation-driven — you appear where a satellite senses activity, and satellites are '
      + 'static — so it cannot be changed by tool call. move applies to virtual places and to '
      + 'Eidoverse places (where your body walks or travels).',
    );
  }
  // Eidoverse plane: the body goes first. A refusal aborts the move BEFORE
  // any presence write, so the situated view never claims a place the body
  // is not in.
  let body: Record<string, unknown> | undefined;
  if (isEidoversePlace(place)) {
    const binding = place.eidoverse;
    const outcome = await requireAvatarOps(ops, 'avatarMove')({
      placeId: place.placeId,
      world: binding.world,
      ...(binding.region ? { region: binding.region } : {}),
      ...(binding.position ? { position: binding.position } : {}),
      ...(params.participant ? { participant: params.participant.trim() } : {}),
    });
    if (!outcome.accepted) {
      throw new Error(
        `the world refused the move to "${placeId}" (${outcome.reason}); your body is still in "${outcome.world}".`,
      );
    }
    body = describeMoveOutcome(outcome);
  }
  const applyVirtualMove = deps.applyVirtualMove;
  if (!applyVirtualMove) {
    // Fail closed rather than half-move: without the local situated seam the
    // next turn would still render the old place (silent drift).
    throw new Error('move is not wired in this runtime (no local situated-state seam).');
  }

  const placeRef: SituatedPlaceRef = {
    siteId: place.siteId,
    placeId: place.placeId,
    kind: place.kind,
  };
  // Contract s10wm: presence is written through the turn port ONLY. A failed
  // shared write throws here and aborts the move BEFORE any local state
  // changes, so local and shared views never diverge. Flag-off (no port) the
  // move is local-only by design: single companion, nothing shared to write.
  if (deps.companionPresence) {
    await deps.companionPresence.recordDeliberateMove(placeRef);
  }
  applyVirtualMove(place.placeId);

  // Occupants: the post-arrival co-presence snapshot (empty flag-off).
  const coPresent = deps.companionPresence?.getCoPresent(placeRef) ?? [];
  const occupants: RoomEntryOccupant[] = coPresent.map((companion) => ({
    displayName: companion.displayName.trim() || companion.companionId,
    kind: 'companion',
  }));

  // W5 entry event: the room-entry system note. Composed against the
  // destination room's identity (v1: the placeId is the room id) and delivered
  // into the session the move was invoked from, so the next turn there carries
  // the entry context. Honest reporting: when the sink or the invoking channel
  // cannot be resolved, the result SAYS the note was skipped.
  let roomEntryNote: 'delivered' | 'skipped_no_sink' | 'skipped_no_channel' = 'skipped_no_sink';
  if (deps.roomEntryNoteSink) {
    const invokingChannelId = resolveInvokingChannelId();
    if (invokingChannelId) {
      const note = composeRoomEntryNote({
        roomChannelId: place.placeId,
        place,
        affordances: place.affordances,
        present: occupants,
      });
      deps.roomEntryNoteSink.appendContextSystemNote(invokingChannelId, note, ROOM_ENTRY_NOTE_SOURCE);
      roomEntryNote = 'delivered';
    } else {
      roomEntryNote = 'skipped_no_channel';
    }
  }

  const description = place.description?.trim();
  const exits = listExits(deps.placesRegistry, place, deps);
  const alsoHere = occupants.map((occupant) => occupant.displayName);
  // MUD-style summary: destination description + who's here + exits.
  const summary = [
    `You are now in ${place.displayName}.`,
    ...(body ? [body.summary as string] : []),
    ...(description ? [description] : []),
    alsoHere.length > 0 ? `Also here: ${alsoHere.join(', ')}.` : 'No one else is here.',
    exits.length > 0
      ? `Exits: ${exits.map((exit) => `${exit.displayName as string} (${exit.placeId as string})`).join(', ')}.`
      : 'There are no other places at this site.',
  ].join(' ');

  return JSON.stringify({
    action: 'move',
    placeId: place.placeId,
    place: place.displayName,
    siteId: place.siteId,
    kind: place.kind,
    ...(description ? { description } : {}),
    alsoHere,
    exits,
    presenceWrite: deps.companionPresence ? 'shared' : 'local_only',
    roomEntryNote,
    ...(body ? { body } : {}),
    summary,
  }, null, 2);
}

/**
 * One Eidoverse body or creation verb. Tier: body verbs ride `world.read`
 * like move; creation verbs ride `world.control` (resolved by the capability
 * gate outside this tool from `params.verb`). The Hub's allowlist and the
 * door's own refusals are reported, never papered over.
 */
async function runAct(ops: WorldOperations, params: WorldToolParams): Promise<string> {
  const verb = typeof params.verb === 'string' ? params.verb.trim() : '';
  if (!isWorldAvatarVerb(verb)) {
    throw new Error(
      `action=act requires verb as one of: ${[...WORLD_AVATAR_BODY_VERBS, ...WORLD_AVATAR_EDIT_VERBS].join(', ')}.`,
    );
  }
  const args = (params.arguments ?? {}) as unknown;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('action=act arguments must be an object.');
  }
  const outcome = await requireAvatarOps(ops, 'avatarAct')({ verb, arguments: args as Record<string, unknown> });
  if (!outcome.accepted) {
    return JSON.stringify({
      action: 'act',
      verb,
      accepted: false,
      reason: outcome.reason,
      summary: `The world did not accept ${verb} (${outcome.reason}).`,
    }, null, 2);
  }
  return JSON.stringify({
    action: 'act',
    verb,
    accepted: true,
    outcome: outcome.outcome,
    ...(outcome.reply ? { reply: outcome.reply } : {}),
    editsWorld: isWorldAvatarEditVerb(verb),
    summary: outcome.outcome === 'pending'
      ? `${verb} was accepted and is still running; its outcome reaches you on a later turn.`
      : `${verb}: ${outcome.reply ?? outcome.outcome}.`,
  }, null, 2);
}

export function createWorldTool(ops: WorldOperations, deps: WorldToolDeps): SubstrateAgentTool {
  return {
    name: 'world',
    label: 'world',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.world,
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('perceive'),
        Type.Literal('list'),
        Type.Literal('control'),
        Type.Literal('move'),
        Type.Literal('act'),
      ], {
        description: 'World action: perceive, list, control, move, or act.',
      })),
      placeId: Type.Optional(Type.String({
        description: 'Target place id, matched exactly against places.json as authored. Ids are arbitrary '
          + 'operator-defined strings with no guaranteed "place." prefix (e.g. "bedroom"); do not guess. '
          + 'Use action=list to discover the exact ids. Defaults to the situated place for perceive/list. '
          + 'For move: a virtual place, or an Eidoverse place (your body walks there, or travels when it is in '
          + 'another world); omit it to move by participant or position instead.',
      })),
      participant: Type.Optional(Type.String({
        description: 'Used with action=move. Walk your Eidoverse body to this participant, by the id shown before '
          + 'their messages (e.g. "visitor"); a leading @ is fine. You stop beside them.',
      })),
      position: Type.Optional(Type.Object({
        x: Type.Number(),
        z: Type.Number(),
      }, {
        description: 'Used with action=move. Walk your Eidoverse body to this ground-plane (x, z) in the current world.',
      })),
      verb: Type.Optional(Type.Union([
        Type.Literal('face'),
        Type.Literal('stop'),
        Type.Literal('emote'),
        Type.Literal('posture'),
        Type.Literal('whisper'),
        Type.Literal('take_off'),
        Type.Literal('climb_to'),
        Type.Literal('glide_to'),
        Type.Literal('land_at'),
        Type.Literal('fold_wings'),
        Type.Literal('unfold_wings'),
        Type.Literal('flight_status'),
        Type.Literal('spawn'),
        Type.Literal('remove'),
        Type.Literal('set_avatar'),
      ], {
        description: 'Used with action=act. Eidoverse body verb (face, stop, emote, posture, whisper), flight verb '
          + '(take_off, climb_to, glide_to, land_at, fold_wings, unfold_wings, flight_status; the world refuses when '
          + 'your body has no wings, no fly permission, or no stamina), or creation verb '
          + '(spawn, remove, set_avatar; needs the world.control tier).',
      })),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: 'Used with action=act. face: {target} or {x, z}; emote: {name: wave|cheer|dance|point|salute|clap|talk|flail}; '
          + 'posture: {kind: sit|sitchair|lie|stand}; whisper: {to: participant id, text} (private, unlogged); '
          + 'climb_to: {altitude: metres}; glide_to and land_at: {x, z}; take_off, fold_wings, unfold_wings and '
          + 'flight_status take no arguments (read the reply: altitude, stamina, why you are still standing); '
          + 'spawn: {query or lib, x?, z?, yaw?, id?}; remove: {id}; set_avatar: {avatar}.',
      })),
      affordanceId: Type.Optional(Type.String({
        description: 'Used with action=control. Registry affordance id, matched exactly against places.json as '
          + 'authored. Ids are arbitrary operator-defined strings (e.g. "bedroom_lights"); do not guess '
          + 'singular/plural or prefixes. Use action=list to discover the exact ids.',
      })),
      command: Type.Optional(Type.Union([
        Type.Literal('on'),
        Type.Literal('off'),
        Type.Literal('toggle'),
      ], {
        description: 'Used with action=control. Effector command.',
      })),
      intent: Type.Optional(Type.Union([
        Type.Literal('direct'),
        Type.Literal('presence_enter'),
        Type.Literal('presence_exit'),
        Type.Literal('attention'),
        Type.Literal('sleep'),
        Type.Literal('wake'),
      ], {
        description: 'Why control is being initiated. Required for unattended companion actions.',
      })),
      reason: Type.Optional(Type.String({
        description: 'Human-readable audit reason. Required for unattended companion actions.',
        minLength: 1,
        maxLength: 240,
      })),
      scope: Type.Optional(Type.Union([
        Type.Literal('place'),
        Type.Literal('site'),
      ], {
        description: 'Used with action=list. "site" enumerates every place; default is the situated/explicit place.',
      })),
      data: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: 'Used with action=control. Optional extra Home Assistant service data (e.g. brightness).',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: WorldToolParams = {},
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let actionForError = typeof params.action === 'string' ? params.action : undefined;
      try {
        const action = normalizeWorldAction(params);
        actionForError = action;
        switch (action) {
          case 'perceive':
            return textResult(await runPerceive(ops, deps, params));
          case 'list':
            return textResult(await runList(ops, deps, params));
          case 'control':
            return textResult(await runControl(ops, deps, params));
          case 'move':
            return textResult(await runMove(ops, deps, params));
          case 'act':
            return textResult(await runAct(ops, params));
        }
      } catch (error) {
        const suffix = actionForError ? ` for action=${actionForError}` : '';
        return textResultWithError(`world failed${suffix}: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
