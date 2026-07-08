import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type {
  AffordanceConfig,
  PlaceConfig,
  PlacesRegistryConfig,
} from '../../../shared/contracts/places-registry.js';
import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { isHighTierTrustLevel, type TrustLevel } from '../../../system/trust/types.js';
import type { WorldOperations } from './ops.js';

// ── Agent-side `world` tool (Sprint 10, Workstream C2 + C3/C4) ──
//
// One action-dispatched tool over the physical/virtual world. Actions:
//   perceive  — read Home-Assistant states for a place's affordances + summary
//   list      — enumerate affordances for a place (default) or the whole site
//   control   — call an HA service on an effector affordance
//
// Affordance → entity resolution happens HERE, agent-side, against `places.json`
// (defence in depth): the gateway only ever receives an `entity_id`/`service`
// this tool proved is in the registry. An `affordanceId`/`placeId` absent from
// the registry is rejected BEFORE any RPC crosses to the gateway.
//
// Control gating (bead vinz.10) — three independent, fail-closed gates guard
// `action=control`; perceive/list are unaffected:
//   1. Capability token `world.control` — enforced OUTSIDE this tool by the
//      capability gate (see resolveWorldRequirement). Withheld from every
//      default tier, so a regular/public tier cannot even surface control.
//   2. Staged-off runtime flag `WORLD_CONTROL_RUNTIME_ENABLED` (robotics
//      pattern) — control ships defined, wired, and OFF until the actuation
//      path is proven end-to-end against real hardware. While off, control
//      refuses fail-closed; read stays live.
//   3. Requester trust — only primary/trusted requesters (owner/partner) may
//      drive effectors; regular/public are refused.

const WORLD_ACTION_HELP = 'perceive, list, control';

/**
 * Staged-off runtime gate for effector actuation (mirrors how `robotics` is
 * excluded from `SATELLITE_RUNTIME_ENABLED_CAPABILITIES`). Ships `false`:
 * `action=control` refuses fail-closed until the control path is proven
 * end-to-end. Enable path: flip this to `true` AND grant the `world.control`
 * capability token to the operating tier (both are required — defence in
 * depth). Read (perceive/list) is unaffected.
 */
export const WORLD_CONTROL_RUNTIME_ENABLED = false;

type WorldAction = 'perceive' | 'list' | 'control';
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
   * Staged-off gate for `action=control`. Defaults to
   * `WORLD_CONTROL_RUNTIME_ENABLED` (false). When false, control refuses
   * fail-closed; perceive/list stay live.
   */
  controlEnabled?: boolean;
  /**
   * Resolves the current requester's trust level for the turn (owner/partner =
   * primary/trusted). Supplied at runtime from the turn request context
   * (`viewerTrustLevel`). Absent or non-high-tier ⇒ control is refused.
   */
  resolveRequesterTrust?: () => TrustLevel | undefined;
}

interface ResolvedAffordance {
  place: PlaceConfig;
  affordance: AffordanceConfig;
}

function normalizeWorldAction(params: WorldToolParams): WorldAction {
  const raw = typeof params.action === 'string' ? params.action.trim() : '';
  if (raw === 'perceive' || raw === 'list' || raw === 'control') {
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
  // Gate 1 — staged-off runtime flag (robotics pattern). Fail closed while off.
  const controlEnabled = deps.controlEnabled ?? WORLD_CONTROL_RUNTIME_ENABLED;
  if (!controlEnabled) {
    throw new Error(
      'world control is staged off: effector actuation is disabled until proven end-to-end. '
      + 'Perceive and list remain available. Enabling requires flipping WORLD_CONTROL_RUNTIME_ENABLED '
      + 'and granting the world.control capability token to the operating tier.',
    );
  }

  // Gate 2 — requester trust. Only primary/trusted (owner/partner) drive effectors.
  const requesterTrust = deps.resolveRequesterTrust?.();
  if (!requesterTrust || !isHighTierTrustLevel(requesterTrust)) {
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

export function createWorldTool(ops: WorldOperations, deps: WorldToolDeps): AgentTool<any> {
  return {
    name: 'world',
    label: 'world',
    description:
      'Perceive and control the physical/virtual world through the places registry and Home Assistant. '
      + 'Use action=perceive to read a place\'s live affordance states, action=list to enumerate '
      + 'affordances for a place or the whole site, and action=control to actuate an effector. '
      + 'Address any affordance globally by affordanceId; omit placeId to default to where you are.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('perceive'),
        Type.Literal('list'),
        Type.Literal('control'),
      ], {
        description: 'World action: perceive, list, or control.',
      })),
      placeId: Type.Optional(Type.String({
        description: 'Target place id (e.g. place.living-room). Defaults to the situated place for perceive/list.',
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
        }
      } catch (error) {
        const suffix = actionForError ? ` for action=${actionForError}` : '';
        return textResultWithError(`world failed${suffix}: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
