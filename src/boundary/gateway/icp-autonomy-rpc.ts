import type { JSONRPCServerAndClient } from 'json-rpc-2.0';

import type { IcpSharedAutonomyStorePort } from '../../core/icp/autonomy-store-ports.js';
import type { GatewayCompanionChannelLane } from './companion-channels.js';
import {
  GatewayIcpAutonomyBroker,
} from './icp-autonomy-broker.js';
import {
  parseIcpAvailabilityClearParams,
  parseIcpAvailabilityPublishParams,
  parseIcpInitiationHandoffPrepareParams,
  parseIcpInitiationPermitIssueInput,
  parseIcpInitiationPreflightInput,
  parseIcpPeerAvailabilityReadParams,
  parseIcpPermitConsumeParams,
  parseIcpPermitInvalidateSelfParams,
  parseIcpPermitRevokeParams,
} from './icp-autonomy-contract.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { GatewayIcpInitiationPolicyAuthority } from './icp-initiation-policy-authority.js';

interface GatewayIcpAutonomyRpcOptions {
  store: IcpSharedAutonomyStorePort;
  fleetCompanionIds: ReadonlySet<string>;
  companionChannels?: GatewayCompanionChannelLane;
  isCompanionReady(companionId: string): boolean;
  policyAuthority: Pick<GatewayIcpInitiationPolicyAuthority, 'resolve' | 'authorizeHandoff'>;
  eventBus: EventBus;
  alarm(event: string, message: string, details: Record<string, unknown>): void;
}

interface RegisterGatewayIcpAutonomyRpcInput {
  target: JSONRPCServerAndClient;
  broker: GatewayIcpAutonomyBroker | null;
  requireAuthenticatedCompanionId(): string;
  audited<P, R>(
    method: string,
    handler: (params: P) => Promise<R>,
    paramsSummary?: (params: P) => Record<string, unknown>,
  ): (params: P) => Promise<R>;
}

export function createGatewayIcpAutonomyBroker(
  options: GatewayIcpAutonomyRpcOptions,
): GatewayIcpAutonomyBroker {
  return new GatewayIcpAutonomyBroker({
    store: options.store,
    fleetCompanionIds: options.fleetCompanionIds,
    isCompanionReady: options.isCompanionReady,
    policyAuthority: options.policyAuthority,
    resolveInitiationChannel: async (senderCompanionId, peerCompanionId, channelId) => {
      const lane = options.companionChannels;
      if (!lane) return { ok: false, reasonCode: 'channel_mismatch' };
      const result = await lane.resolveInitiation(senderCompanionId, peerCompanionId, channelId);
      if (result.ok) return { ok: true };
      if (result.violation.event === 'companion_channel_unparseable') {
        return { ok: false, reasonCode: 'malformed_channel' };
      }
      if (result.violation.event.includes('unknown_participant')
        || result.violation.event.includes('unknown_peer')) {
        return { ok: false, reasonCode: 'unknown_participant' };
      }
      return { ok: false, reasonCode: 'channel_mismatch' };
    },
    eventBus: options.eventBus,
    alarm: options.alarm,
  });
}

export function registerGatewayIcpAutonomyRpc(input: RegisterGatewayIcpAutonomyRpcInput): void {
  const requireBroker = (): GatewayIcpAutonomyBroker => {
    if (!input.broker) {
      throw new Error('ICP autonomy broker is not configured on this gateway');
    }
    return input.broker;
  };

  input.target.addMethod('companion.availability.publish', input.audited(
    'companion.availability.publish',
    async (params: unknown) => {
      const companionId = input.requireAuthenticatedCompanionId();
      return await requireBroker().publishAvailability(
        companionId,
        parseIcpAvailabilityPublishParams(params),
      );
    },
    () => ({ companionId: input.requireAuthenticatedCompanionId() }),
  ));
  input.target.addMethod('companion.availability.clear', input.audited(
    'companion.availability.clear',
    async (params: unknown) => {
      const companionId = input.requireAuthenticatedCompanionId();
      const parsed = parseIcpAvailabilityClearParams(params);
      return { cleared: await requireBroker().clearAvailability(companionId, parsed.expectedRevision) };
    },
    () => ({ companionId: input.requireAuthenticatedCompanionId() }),
  ));
  input.target.addMethod('companion.availability.read_peer', input.audited(
    'companion.availability.read_peer',
    async (params: unknown) => {
      const companionId = input.requireAuthenticatedCompanionId();
      const parsed = parseIcpPeerAvailabilityReadParams(params);
      return await requireBroker().readPeerAvailability(companionId, parsed.peerCompanionId);
    },
    () => ({ companionId: input.requireAuthenticatedCompanionId() }),
  ));
  input.target.addMethod('companion.availability.read_self', input.audited(
    'companion.availability.read_self',
    async (params: unknown) => {
      if (params !== undefined) {
        if (typeof params !== 'object' || params === null || Array.isArray(params)) {
          throw new Error('ICP own availability params must be an object');
        }
        const keys = Object.keys(params as Record<string, unknown>);
        if (keys.some(key => key !== 'companionId')) {
          throw new Error(`ICP own availability params contains unknown key "${keys.find(key => key !== 'companionId')}"`);
        }
      }
      return await requireBroker().readOwnAvailability(input.requireAuthenticatedCompanionId());
    },
    () => ({ companionId: input.requireAuthenticatedCompanionId() }),
  ));
  input.target.addMethod('companion.initiation.preflight', input.audited(
    'companion.initiation.preflight',
    async (params: unknown) => {
      const companionId = input.requireAuthenticatedCompanionId();
      return await requireBroker().preflight(
        companionId,
        parseIcpInitiationPreflightInput(params, Date.now()),
      );
    },
    () => ({ companionId: input.requireAuthenticatedCompanionId() }),
  ));
  input.target.addMethod('companion.initiation.permit.issue', input.audited(
    'companion.initiation.permit.issue',
    async (params: unknown) => {
      const companionId = input.requireAuthenticatedCompanionId();
      return await requireBroker().issuePermit(
        companionId,
        parseIcpInitiationPermitIssueInput(params, Date.now()),
      );
    },
    () => ({ companionId: input.requireAuthenticatedCompanionId() }),
  ));
  input.target.addMethod('companion.initiation.permit.prepare_handoff', input.audited(
    'companion.initiation.permit.prepare_handoff',
    async (params: unknown) => {
      const companionId = input.requireAuthenticatedCompanionId();
      return await requireBroker().prepareInitiationHandoff(
        companionId,
        parseIcpInitiationHandoffPrepareParams(params),
      );
    },
    () => ({ companionId: input.requireAuthenticatedCompanionId() }),
  ));
  input.target.addMethod('companion.initiation.permit.consume', input.audited(
    'companion.initiation.permit.consume',
    async (params: unknown) => {
      const companionId = input.requireAuthenticatedCompanionId();
      const result = await requireBroker().consumePermit(
        companionId,
        parseIcpPermitConsumeParams(params),
      );
      return {
        outcome: result.outcome,
        ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
        ...(result.permit ? { status: result.permit.status, revision: result.permit.revision } : {}),
      };
    },
    () => ({ companionId: input.requireAuthenticatedCompanionId() }),
  ));
  input.target.addMethod('companion.initiation.permit.revoke', input.audited(
    'companion.initiation.permit.revoke',
    async (params: unknown) => {
      const companionId = input.requireAuthenticatedCompanionId();
      const parsed = parseIcpPermitRevokeParams(params);
      const revoked = await requireBroker().revokePermit(
        companionId,
        parsed.permitId,
        parsed.expectedRevision,
      );
      return {
        status: 'revoked' as const,
        revision: revoked.revision,
        reasonCode: revoked.reasonCode ?? 'candidate_cancelled',
      };
    },
    () => ({ companionId: input.requireAuthenticatedCompanionId() }),
  ));
  input.target.addMethod('companion.initiation.permit.invalidate_for_self', input.audited(
    'companion.initiation.permit.invalidate_for_self',
    async (params: unknown) => {
      const companionId = input.requireAuthenticatedCompanionId();
      const parsed = parseIcpPermitInvalidateSelfParams(params);
      const revoked = await requireBroker().invalidateForCompanion(companionId, parsed.reasonCode);
      return { revokedCount: revoked.length };
    },
    () => ({ companionId: input.requireAuthenticatedCompanionId() }),
  ));
}
