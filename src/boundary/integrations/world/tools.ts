import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type {
  AffordanceConfig,
  PlaceConfig,
  PlacesRegistryConfig,
} from '../../../shared/contracts/places-registry.js';
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
import type { WorldOperations } from './ops.js';

// ── Agent-side `world` tool (Sprint 10, Workstream C2) ──
//
// One action-dispatched tool over the physical/virtual world. Actions:
//   perceive  — read Home-Assistant states for a place's affordances + summary
//   list      — enumerate affordances for a place (default) or the whole site
//   control   — call an HA service on an effector affordance
//   move      — deliberate self-invoked VIRTUAL navigation (vinz.26, s10wm)
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
// TODO(vinz.10): capability/trust gating (`world.read` / `world.control`) and
// staged-off-by-default control attach at this dispatch boundary. Read
// (perceive/list — and `move`, which gates read-tier like them, NOT like
// control) may ship live; control must stay gated + off until proven
// end-to-end against real hardware. See bead psfn-framework-vinz.10.

const WORLD_ACTION_HELP = 'perceive, list, control, move';

type WorldAction = 'perceive' | 'list' | 'control' | 'move';
type WorldCommand = 'on' | 'off' | 'toggle';

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
  scope?: 'place' | 'site';
  data?: Record<string, unknown>;
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
   * Context-system-note lane for the room-entry note (W5 entry event). The note
   * is delivered into the session channel the move was invoked from (resolved
   * off the turn's request context). Optional: unwired ⇒ the result reports the
   * note as skipped rather than silently pretending it fired.
   */
  roomEntryNoteSink?: RoomEntryNoteSink;
}

interface ResolvedAffordance {
  place: PlaceConfig;
  affordance: AffordanceConfig;
}

function normalizeWorldAction(params: WorldToolParams): WorldAction {
  const raw = typeof params.action === 'string' ? params.action.trim() : '';
  if (raw === 'perceive' || raw === 'list' || raw === 'control' || raw === 'move') {
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

  const summary = readings.length === 0
    ? `${place.displayName}: no Home-Assistant-backed affordances configured.`
    : `${place.displayName}: ${readings.map((r) => `${r.displayName ?? r.affordanceId}=${r.state}`).join(', ')}.`;

  return JSON.stringify({
    action: 'perceive',
    placeId: place.placeId,
    place: place.displayName,
    readings,
    summary,
  }, null, 2);
}

function runList(deps: WorldToolDeps, params: WorldToolParams): string {
  const explicitPlaceId = typeof params.placeId === 'string' && params.placeId.trim()
    ? params.placeId.trim()
    : undefined;
  const siteWide = params.scope === 'site';
  const targetPlaceId = explicitPlaceId
    ?? (siteWide ? undefined : deps.resolveSituatedPlaceId?.());

  const places = targetPlaceId
    ? [resolvePlace(deps.placesRegistry, targetPlaceId)]
    : deps.placesRegistry.places;

  return JSON.stringify({
    action: 'list',
    scope: targetPlaceId ? 'place' : 'site',
    places: places.map((place) => ({
      placeId: place.placeId,
      displayName: place.displayName,
      kind: place.kind,
      affordances: place.affordances.map((affordance) => describeAffordance(place, affordance)),
    })),
  }, null, 2);
}

async function runControl(
  ops: WorldOperations,
  deps: WorldToolDeps,
  params: WorldToolParams,
): Promise<string> {
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
  const service = COMMAND_TO_SERVICE[command];
  const domain = entityId.split('.')[0];

  const response = await ops.callService({
    domain,
    service,
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
function listExits(registry: PlacesRegistryConfig, destination: PlaceConfig): Array<Record<string, unknown>> {
  return registry.places
    .filter((place) => place.siteId === destination.siteId && place.placeId !== destination.placeId)
    .map((place) => ({
      placeId: place.placeId,
      displayName: place.displayName,
      kind: place.kind,
      movable: place.kind === 'virtual',
    }));
}

/** Resolve the invoking turn's session channel from the ambient request context. */
function resolveInvokingChannelId(): string | undefined {
  const channelId = getRequestContext()?.channelId;
  if (typeof channelId !== 'string') return undefined;
  const trimmed = channelId.trim();
  return trimmed ? trimmed : undefined;
}

async function runMove(deps: WorldToolDeps, params: WorldToolParams): Promise<string> {
  const placeId = requirePlainString(params, 'placeId', 'move', 'place.mud-tavern');
  // Fail closed: unknown destination never moves anything.
  const place = resolvePlace(deps.placesRegistry, placeId);
  if (place.kind === 'physical') {
    throw new Error(
      `cannot move to "${placeId}": it is a physical place. Physical presence is `
      + 'emanation-driven — you appear where a satellite senses activity, and satellites are '
      + 'static — so it cannot be changed by tool call. move applies to virtual places only.',
    );
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
  const exits = listExits(deps.placesRegistry, place);
  const alsoHere = occupants.map((occupant) => occupant.displayName);
  // MUD-style summary: destination description + who's here + exits.
  const summary = [
    `You are now in ${place.displayName}.`,
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
    summary,
  }, null, 2);
}

export function createWorldTool(ops: WorldOperations, deps: WorldToolDeps): AgentTool<any> {
  return {
    name: 'world',
    label: 'world',
    description:
      'Perceive, control, and move through the physical/virtual world via the places registry and Home Assistant. '
      + 'Use action=perceive to read a place\'s live affordance states, action=list to enumerate '
      + 'affordances for a place or the whole site, action=control to actuate an effector, and '
      + 'action=move to deliberately walk to a VIRTUAL place (returns its description and exits; '
      + 'physical places cannot be moved to — physical presence follows the satellites sensing you). '
      + 'Address any affordance globally by affordanceId; omit placeId to default to where you are.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('perceive'),
        Type.Literal('list'),
        Type.Literal('control'),
        Type.Literal('move'),
      ], {
        description: 'World action: perceive, list, control, or move.',
      })),
      placeId: Type.Optional(Type.String({
        description: 'Target place id (e.g. place.living-room). Defaults to the situated place for '
          + 'perceive/list; required for move (virtual destination).',
      })),
      affordanceId: Type.Optional(Type.String({
        description: 'Used with action=control. Registry affordance id (e.g. lr_lights). Resolved against places.json.',
      })),
      command: Type.Optional(Type.Union([
        Type.Literal('on'),
        Type.Literal('off'),
        Type.Literal('toggle'),
      ], {
        description: 'Used with action=control. Effector command.',
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
            return textResult(runList(deps, params));
          case 'control':
            return textResult(await runControl(ops, deps, params));
          case 'move':
            return textResult(await runMove(deps, params));
        }
      } catch (error) {
        const suffix = actionForError ? ` for action=${actionForError}` : '';
        return textResultWithError(`world failed${suffix}: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
