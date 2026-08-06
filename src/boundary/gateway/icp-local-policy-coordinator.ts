import { randomUUID } from 'node:crypto';

import {
  deriveIcpLocalPolicyAcquirePayloadDigest,
  parseIcpLocalPolicyAcquireResult,
  parseIcpLocalPolicyInspectResult,
  parseIcpLocalPolicyReleaseResult,
  type IcpLocalPolicyAcquireParams,
  type IcpLocalPolicyInspectParams,
  type IcpLocalPolicyInspectResult,
} from '../../core/icp/local-policy-contract.js';
import { MAX_ICP_POLICY_HOLD_TTL_MS } from '../../system/config/icp-autonomy-scheduler-config.js';
import type { IcpInitiationPolicySnapshot } from './icp-autonomy-contract.js';
import type {
  GatewayIcpInitiationPolicyAuthority,
  IcpAuthorizedHandoffOperationResult,
  IcpInitiationCausalityAuthority,
  IcpInitiationHandoffPolicyDecision,
  IcpInitiationHandoffPolicyInput,
  IcpInitiationPolicyAuthorityInput,
} from './icp-initiation-policy-authority.js';

const POLICY_INSPECT_METHOD = 'icp.policy.inspect';
const POLICY_ACQUIRE_METHOD = 'icp.policy.acquire';
const POLICY_RELEASE_METHOD = 'icp.policy.release';

interface AcquiredPolicyHold {
  companionId: string;
  holdId: string;
  payloadDigest: string;
  nonce: string;
}

export interface GatewayIcpLocalPolicyCoordinatorOptions {
  requestCompanionAgent(
    companionId: string,
    method: string,
    params: unknown,
  ): Promise<unknown>;
  readRelationshipPressure(input: {
    senderCompanionId: string;
    recipientCompanionId: string;
    nowMs: number;
  }): Promise<number>;
  causalityAuthority: IcpInitiationCausalityAuthority;
  reportUnavailable(input: {
    companionIds: readonly string[];
    operation: 'inspect' | 'acquire' | 'release';
    error: unknown;
  }): void;
  randomUuid?: () => string;
}

function closedSnapshot(): IcpInitiationPolicySnapshot {
  return {
    canonicalPeerContact: true,
    senderBlocksPeer: false,
    peerBlocksSender: false,
    trustAllows: false,
    provenanceFresh: false,
    recursiveMiOnlyRoot: true,
    socialPressureAllows: false,
    chargeAllows: false,
    fatigueAllows: false,
    costAllows: false,
  };
}

/**
 * Combines content-free decisions from each companion's authenticated local
 * authority. The gateway never opens a tenant schema or receives private
 * contact identifiers through this seam.
 */
export class GatewayIcpLocalPolicyCoordinator implements GatewayIcpInitiationPolicyAuthority {
  private readonly randomUuid: () => string;
  private closed = false;

  constructor(private readonly options: GatewayIcpLocalPolicyCoordinatorOptions) {
    this.randomUuid = options.randomUuid ?? randomUUID;
  }

  async resolve(input: IcpInitiationPolicyAuthorityInput): Promise<IcpInitiationPolicySnapshot> {
    this.requireOpen();
    const recipientCompanionId = input.candidate.peerCompanionId;
    try {
      const [relationshipPressure, independentRoot] = await Promise.all([
        this.options.readRelationshipPressure({
          senderCompanionId: input.senderCompanionId,
          recipientCompanionId,
          nowMs: input.nowMs,
        }),
        this.options.causalityAuthority.isIndependentRoot(input),
      ]);
      const [sender, recipient] = await Promise.all([
        this.inspect(input.senderCompanionId, {
          role: 'sender',
          senderCompanionId: input.senderCompanionId,
          recipientCompanionId,
          channelId: input.channelId,
          nowMs: input.nowMs,
          candidate: input.candidate,
          relationshipPressure,
        }),
        this.inspect(recipientCompanionId, {
          role: 'recipient',
          senderCompanionId: input.senderCompanionId,
          recipientCompanionId,
          channelId: input.channelId,
          nowMs: input.nowMs,
        }),
      ]);
      if (!sender.ready || !recipient.ready) return closedSnapshot();
      if (sender.role !== 'sender' || recipient.role !== 'recipient') {
        throw new Error('ICP local policy bilateral inspection role mismatch');
      }
      return {
        canonicalPeerContact:
          sender.canonicalPeerContact && recipient.canonicalPeerContact,
        senderBlocksPeer: sender.blocksPeer,
        peerBlocksSender: recipient.blocksPeer,
        trustAllows: sender.trustAllows && recipient.trustAllows,
        provenanceFresh: sender.provenanceFresh,
        recursiveMiOnlyRoot: !independentRoot,
        socialPressureAllows: sender.socialPressureAllows,
        chargeAllows: sender.chargeAllows,
        fatigueAllows: sender.fatigueAllows,
        costAllows: sender.costAllows,
      };
    } catch (error) {
      this.options.reportUnavailable({
        companionIds: [input.senderCompanionId, recipientCompanionId],
        operation: 'inspect',
        error,
      });
      return closedSnapshot();
    }
  }

  async authorizeHandoff(
    input: IcpInitiationHandoffPolicyInput,
  ): Promise<IcpInitiationHandoffPolicyDecision> {
    const guarded = await this.withAuthorizedHandoff(input, async () => undefined);
    return guarded.decision;
  }

  async runAuthorizedHandoff<T>(
    input: IcpInitiationHandoffPolicyInput,
    operation: () => Promise<T>,
  ): Promise<IcpAuthorizedHandoffOperationResult<T>> {
    return await this.withAuthorizedHandoff(input, operation);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async inspect(
    companionId: string,
    params: IcpLocalPolicyInspectParams,
  ): Promise<IcpLocalPolicyInspectResult> {
    const result = await this.options.requestCompanionAgent(
      companionId,
      POLICY_INSPECT_METHOD,
      params,
    );
    const parsed = parseIcpLocalPolicyInspectResult(result);
    if (parsed.role !== params.role) {
      throw new Error('ICP local policy inspection role mismatch');
    }
    return parsed;
  }

  private async withAuthorizedHandoff<T>(
    input: IcpInitiationHandoffPolicyInput,
    operation: () => Promise<T>,
  ): Promise<IcpAuthorizedHandoffOperationResult<T>> {
    this.requireOpen();
    const relationshipPressure = await this.readPressureOrNull(input);
    if (relationshipPressure === null) {
      return { decision: { eligible: false, reasonCode: 'policy_denied' } };
    }
    const expiresAtMs = input.permit.status === 'issued'
      ? input.permit.expiresAtMs
      : input.nowMs + MAX_ICP_POLICY_HOLD_TTL_MS;
    const roles = [
      { companionId: input.senderCompanionId, role: 'sender' as const },
      { companionId: input.permit.recipientCompanionId, role: 'recipient' as const },
    ].sort((left, right) => left.companionId.localeCompare(right.companionId));
    const holds: AcquiredPolicyHold[] = [];
    try {
      for (const target of roles) {
        const nonce = this.randomUuid();
        const digestInput = {
          role: target.role,
          phase: 'consume' as const,
          senderCompanionId: input.senderCompanionId,
          recipientCompanionId: input.permit.recipientCompanionId,
          channelId: input.permit.channelId,
          nowMs: input.nowMs,
          expiresAtMs,
          nonce,
          ...(target.role === 'sender' ? { relationshipPressure } : {}),
          permit: input.permit,
          rootInitiationId: input.rootInitiationId,
        };
        const params: IcpLocalPolicyAcquireParams = {
          ...digestInput,
          payloadDigest: deriveIcpLocalPolicyAcquirePayloadDigest(digestInput),
        };
        const result = parseIcpLocalPolicyAcquireResult(
          await this.options.requestCompanionAgent(
            target.companionId,
            POLICY_ACQUIRE_METHOD,
            params,
          ),
        );
        if (!result.acquired) {
          await this.releaseAll(holds);
          return { decision: { eligible: false, reasonCode: result.reasonCode } };
        }
        holds.push({
          companionId: target.companionId,
          holdId: result.holdId,
          payloadDigest: params.payloadDigest,
          nonce,
        });
      }
    } catch (error) {
      let releaseError: unknown;
      try {
        await this.releaseAll(holds);
      } catch (caught) {
        releaseError = caught;
      }
      this.options.reportUnavailable({
        companionIds: roles.map(role => role.companionId),
        operation: 'acquire',
        error,
      });
      if (releaseError) throw new AggregateError([error, releaseError], 'ICP policy acquire and release failed');
      return { decision: { eligible: false, reasonCode: 'policy_denied' } };
    }

    let result: T;
    try {
      result = await operation();
    } catch (error) {
      try {
        await this.releaseAll(holds);
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'ICP operation and policy release failed');
      }
      throw error;
    }
    await this.releaseAll(holds);
    return { decision: { eligible: true }, result };
  }

  private async readPressureOrNull(
    input: IcpInitiationHandoffPolicyInput,
  ): Promise<number | null> {
    try {
      return await this.options.readRelationshipPressure({
        senderCompanionId: input.senderCompanionId,
        recipientCompanionId: input.permit.recipientCompanionId,
        nowMs: input.nowMs,
      });
    } catch (error) {
      this.options.reportUnavailable({
        companionIds: [input.senderCompanionId, input.permit.recipientCompanionId],
        operation: 'acquire',
        error,
      });
      return null;
    }
  }

  private async releaseAll(holds: AcquiredPolicyHold[]): Promise<void> {
    const failures: unknown[] = [];
    for (const hold of [...holds].reverse()) {
      try {
        parseIcpLocalPolicyReleaseResult(await this.options.requestCompanionAgent(
          hold.companionId,
          POLICY_RELEASE_METHOD,
          {
            holdId: hold.holdId,
            payloadDigest: hold.payloadDigest,
            nonce: hold.nonce,
          },
        ));
      } catch (error) {
        this.options.reportUnavailable({
          companionIds: [hold.companionId],
          operation: 'release',
          error,
        });
        failures.push(error);
      }
    }
    holds.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to release ICP local policy holds');
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('ICP local policy coordinator is closed');
  }
}
