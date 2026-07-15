import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import {
  ICP_AVAILABILITY_STATES,
  MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
  type IcpAvailabilityState,
} from '../../shared/contracts/icp-autonomy.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import type { AgentFacingIcpAutonomyRuntime } from '../icp/agent-facing-autonomy.js';
import { textResult, textResultWithError } from './results.js';

export const SELF_AVAILABILITY_ACTIONS = [
  'availability_read',
  'availability_publish',
  'availability_clear',
  'availability_list_peers',
] as const;

export type SelfAvailabilityAction = (typeof SELF_AVAILABILITY_ACTIONS)[number];

export interface SelfAvailabilityParams {
  action: SelfAvailabilityAction;
  state?: IcpAvailabilityState;
  expires_at_ms?: number;
  revision?: number;
  expected_revision?: number;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function parsePublish(params: unknown, nowMs: number): {
  state: IcpAvailabilityState;
  expiresAtMs: number;
  revision: number;
} {
  if (!isRecord(params)) throw new Error('self_status availability_publish params must be an object');
  assertNoUnknownKeys(
    params,
    ['action', 'state', 'expires_at_ms', 'revision'],
    'self_status availability_publish params',
  );
  if (typeof params.state !== 'string'
    || !ICP_AVAILABILITY_STATES.includes(params.state as IcpAvailabilityState)) {
    throw new Error(`state must be one of: ${ICP_AVAILABILITY_STATES.join(', ')}`);
  }
  const expiresAtMs = requirePositiveInteger(params.expires_at_ms, 'expires_at_ms');
  if (expiresAtMs <= nowMs) throw new Error('expires_at_ms must be in the future');
  if (expiresAtMs - nowMs > MAX_ICP_AVAILABILITY_LEASE_TTL_MS) {
    throw new Error(`availability lease exceeds maximum TTL ${MAX_ICP_AVAILABILITY_LEASE_TTL_MS}ms`);
  }
  return {
    state: params.state as IcpAvailabilityState,
    expiresAtMs,
    revision: requirePositiveInteger(params.revision, 'revision'),
  };
}

function assertOnlyAction(params: unknown, action: SelfAvailabilityAction): void {
  if (!isRecord(params)) throw new Error(`self_status ${action} params must be an object`);
  assertNoUnknownKeys(params, ['action'], `self_status ${action} params`);
}

export async function executeSelfAvailabilityAction(input: {
  runtime: AgentFacingIcpAutonomyRuntime;
  params: SelfAvailabilityParams;
  nowMs?: number;
}): Promise<AgentToolResult<{ isError?: boolean }>> {
  try {
    switch (input.params.action) {
      case 'availability_read': {
        assertOnlyAction(input.params, input.params.action);
        const result = await input.runtime.readOwnAvailability();
        return textResult(JSON.stringify({ action: input.params.action, ...result }, null, 2));
      }
      case 'availability_publish': {
        const parsed = parsePublish(input.params, input.nowMs ?? Date.now());
        const lease = await input.runtime.publishOwnAvailability(parsed);
        return textResult(JSON.stringify({
          action: input.params.action,
          status: 'published',
          lease,
          mutableByCompanion: lease.source !== 'operator',
        }, null, 2));
      }
      case 'availability_clear': {
        if (!isRecord(input.params)) throw new Error('self_status availability_clear params must be an object');
        assertNoUnknownKeys(
          input.params,
          ['action', 'expected_revision'],
          'self_status availability_clear params',
        );
        const result = await input.runtime.clearOwnAvailability(
          requirePositiveInteger(input.params.expected_revision, 'expected_revision'),
        );
        if (!result.cleared) throw new Error('availability clear rejected by current revision or override');
        return textResult(JSON.stringify({ action: input.params.action, status: 'cleared' }, null, 2));
      }
      case 'availability_list_peers': {
        assertOnlyAction(input.params, input.params.action);
        if (getRequestContext()?.icpCorrelation) {
          throw new Error('peer availability listing is blocked during an ICP-correlated turn');
        }
        const peers = await input.runtime.listKnownPeerAvailability();
        return textResult(JSON.stringify({
          action: input.params.action,
          peers: peers.map(peer => ({
            contactId: peer.contactId,
            displayName: peer.displayName,
            connectionState: peer.availability.connectionState,
            eligible: peer.availability.eligible,
            ...(peer.availability.reasonCode ? { reasonCode: peer.availability.reasonCode } : {}),
            ...(peer.availability.lease
              ? {
                  state: peer.availability.lease.state,
                  source: peer.availability.lease.source,
                  expiresAtMs: peer.availability.lease.expiresAtMs,
                  revision: peer.availability.lease.revision,
                }
              : {}),
          })),
        }, null, 2));
      }
    }
  } catch (error) {
    return textResultWithError(
      `self_status action=${input.params.action} failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}
