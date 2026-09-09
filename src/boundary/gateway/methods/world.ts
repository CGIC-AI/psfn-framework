import type {
  WorldAvatarActParams,
  WorldAvatarActResult,
  WorldAvatarMoveParams,
  WorldAvatarMoveResult,
  WorldAvatarPerceiveParams,
  WorldAvatarPerceiveResult,
} from '../protocol.js';
import type { GatewayMethodRuntime } from './types.js';
import { defineGatedMethod } from './types.js';
import { registerGatedDescriptors } from './register.js';
import { gatewayMethodParamDecoders } from './params.js';
import { isRecord } from '../../../shared/utils/types.js';
import { isWorldAvatarVerb } from '../../../shared/contracts/world-avatar.js';
import { denyPolicy as deny, providerError, requestSatelliteHub } from './satellite-hub-transport.js';

// ── World avatar methods (S13 MOVE) ──
//
// The companion's OWN body in the Eidoverse: perceive the 3D scene, move
// (travel and/or walk), and act (body and creation verbs). Forwarded to the
// Satellite Hub's private control port with the gateway's Hub control token.
// No Hub device assertion is involved anywhere on this path: that door is for
// external devices driving the body over the Hub's satellite socket.
//
// Tier gating is the agent-side capability gate's job (`world.read` for
// perceive/move/body verbs, `world.control` for creation verbs); the policy
// here only asks whether the transport is configured.

const WORLD_NAME_PATTERN = /^[a-z0-9_-]{1,64}$/u;
const LABEL_PATTERN = /^[^\s][^\r\n]{0,127}$/u;
/** A move may include a door round trip for travel plus a bounded walk wait. */
const MOVE_TIMEOUT_MS = 25_000;
const MAX_MOVE_WAIT_MS = 15_000;

function parseWorldName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !WORLD_NAME_PATTERN.test(value.trim())) deny('world must match the door world-name grammar');
  return value.trim();
}

function parseLabel(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !LABEL_PATTERN.test(value.trim())) deny(`${field} must be a short label`);
  return value.trim();
}

function parsePosition(value: unknown): { x: number; z: number } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !Number.isFinite(value.x) || !Number.isFinite(value.z)) deny('position must carry finite x and z');
  return { x: value.x as number, z: value.z as number };
}

function parsePerception(payload: unknown): WorldAvatarPerceiveResult {
  if (!isRecord(payload) || typeof payload.world !== 'string' || !Array.isArray(payload.people) || !Array.isArray(payload.things)) {
    providerError('Malformed Satellite Hub perception');
  }
  return payload as unknown as WorldAvatarPerceiveResult;
}

function parseMoveOutcome(payload: unknown): WorldAvatarMoveResult {
  if (!isRecord(payload) || typeof payload.accepted !== 'boolean' || typeof payload.world !== 'string') {
    providerError('Malformed Satellite Hub move outcome');
  }
  return payload as unknown as WorldAvatarMoveResult;
}

function parseActOutcome(payload: unknown): WorldAvatarActResult {
  if (!isRecord(payload) || typeof payload.accepted !== 'boolean' || typeof payload.verb !== 'string') {
    providerError('Malformed Satellite Hub act outcome');
  }
  return payload as unknown as WorldAvatarActResult;
}

const descriptors = [
  defineGatedMethod<WorldAvatarPerceiveParams, WorldAvatarPerceiveResult>({
    name: 'world.avatar_perceive',
    decode: gatewayMethodParamDecoders['world.avatar_perceive'],
    handler: async (_params, runtime): Promise<WorldAvatarPerceiveResult> => {
      const payload = await requestSatelliteHub(runtime, '/internal/v1/world/perceive', 'POST', {});
      return parsePerception(payload);
    },
    summary: (params) => ({ action: 'avatar_perceive', placeId: params.placeId ?? null }),
    approvalAction: 'world.avatar.read',
    approvalScope: (params) => params.placeId ?? 'current',
  }),
  defineGatedMethod<WorldAvatarMoveParams, WorldAvatarMoveResult>({
    name: 'world.avatar_move',
    decode: gatewayMethodParamDecoders['world.avatar_move'],
    handler: async (params, runtime): Promise<WorldAvatarMoveResult> => {
      const world = parseWorldName(params.world);
      const region = parseLabel(params.region, 'region');
      const participant = parseLabel(params.participant, 'participant');
      const position = parsePosition(params.position);
      if (!world && !region && !participant && !position) deny('move needs a world, region, position or participant');
      const waitMs = params.waitMs === undefined
        ? undefined
        : Math.min(Math.max(0, Number(params.waitMs) || 0), MAX_MOVE_WAIT_MS);
      const payload = await requestSatelliteHub(runtime, '/internal/v1/world/move', 'POST', {
        ...(world ? { world } : {}),
        ...(region ? { region } : {}),
        ...(participant ? { participant } : {}),
        ...(position ? { position } : {}),
        ...(waitMs !== undefined ? { waitMs } : {}),
      }, { timeoutMs: MOVE_TIMEOUT_MS });
      return parseMoveOutcome(payload);
    },
    summary: (params) => ({
      action: 'avatar_move',
      placeId: params.placeId ?? null,
      world: params.world ?? null,
      region: params.region ?? null,
      participant: params.participant ?? null,
      position: params.position ?? null,
    }),
    approvalAction: 'world.avatar.move',
    approvalScope: (params) => params.placeId ?? params.world ?? params.participant ?? 'position',
  }),
  defineGatedMethod<WorldAvatarActParams, WorldAvatarActResult>({
    name: 'world.avatar_act',
    decode: gatewayMethodParamDecoders['world.avatar_act'],
    handler: async (params, runtime): Promise<WorldAvatarActResult> => {
      const verb = typeof params.verb === 'string' ? params.verb.trim() : '';
      if (!isWorldAvatarVerb(verb)) deny('verb is not a world-avatar body or creation verb');
      const args = params.arguments ?? {};
      if (!isRecord(args)) deny('arguments must be an object');
      const payload = await requestSatelliteHub(runtime, '/internal/v1/world/act', 'POST', { verb, arguments: args });
      return parseActOutcome(payload);
    },
    summary: (params) => ({ action: 'avatar_act', verb: params.verb }),
    approvalAction: 'world.avatar.act',
    approvalScope: (params) => params.verb,
  }),
];

export function registerWorldMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, descriptors);
}
