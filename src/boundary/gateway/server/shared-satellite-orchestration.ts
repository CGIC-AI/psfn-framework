// Shared-satellite response orchestration: one speech lease per shared
// device conversation, arbitrated across eligible companions for both the
// satellite HTTP chat path and the voice stream path, with per-companion
// eligibility (availability, fatigue, quiet hours, rest, device membership)
// and content-free lease/observation audits.
import { isRecord } from '../../../shared/utils/types.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { SatelliteRoutingMetadata } from '../../../shared/contracts/satellite-registry.js';
import type { CompanionId } from '../../../shared/routing/companion-id.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type {
  ApiChatCompletionRpcParams,
  ApiChatCompletionRpcResult,
} from '../../../channels/api/types.js';
import type { VoiceHandleMessageResult } from '../protocol.js';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  requestAgentVoiceStream,
  type VoiceStreamRequestOptions,
} from '../voice-stream-request.js';
import { materializeGatewayAttachments } from '../attachment-materialization.js';
import {
  SharedSatelliteResponseArbiter,
  type SharedSatelliteEligibility,
  type SharedSatelliteLeaseAuditEvent,
} from '../shared-satellite-response-arbiter.js';
import type { GatewayServerPorts } from './ports.js';

const log = createComponentLogger('Gateway');

export class GatewaySharedSatelliteOrchestrator {
  private readonly sharedSatelliteResponseArbiter: SharedSatelliteResponseArbiter;
  readonly sharedSatelliteChatRequests = new Map<string, CompanionId>();

  constructor(
    private readonly ports: Pick<
      GatewayServerPorts,
      | 'options'
      | 'audit'
      | 'icpAutonomyBroker'
      | 'rpcClients'
      | 'wyomingShardRouting'
      | 'nextStreamRequestCounter'
      | 'inspectAgentReply'
      | 'requestCompanionAgent'
      | 'requireReadyCompanionRoute'
      | 'resolveReadyCompanionConnection'
      | 'resolveConnectionWorkspacePath'
      | 'refreshConnectionHealth'
    >,
  ) {
    this.sharedSatelliteResponseArbiter = new SharedSatelliteResponseArbiter({
      audit: event => {
        void this.recordSharedSatelliteLeaseAudit(event).catch((error: unknown) => {
          log.error('Failed to persist shared-satellite response lease audit', {
            action: event.action,
            satelliteId: event.satelliteId,
            companionId: event.companionId,
            error: toErrorMessage(error),
          });
        });
      },
    });
  }

  /** Persist and publish a content-free observation-delivery audit. */
  async recordSharedSatelliteObservationAudit(event: {
    satelliteId: string;
    companionId: string;
    scope: string;
    eventId: string;
    timestamp: number;
  }): Promise<void> {
    await this.ports.audit('satellite.observation.delivered', 'ALLOW', event);
    await this.ports.options.eventBus.emit('satellite.observation.delivered', event);
  }

  /**
   * Run an authenticated satellite HTTP turn through the same speech lease as
   * voice. This is the only multi-companion satellite chat model-call path.
   */
  async requestSharedSatelliteChatCompletion(input: {
    satellite: SatelliteRoutingMetadata & {
      sharedDevice: NonNullable<SatelliteRoutingMetadata['sharedDevice']>;
    };
    canonicalContactId: string;
    channelId: string;
    /** Exact gateway-authenticated target for an inbound human Hub-device turn. */
    explicitHumanInboundCompanionId?: CompanionId;
    params: ApiChatCompletionRpcParams;
    timeoutMs: number;
  }): Promise<ApiChatCompletionRpcResult> {
    const { satellite, params } = input;
    const policy = satellite.sharedDevice;
    const eligibility = await this.resolveSharedSatelliteEligibility({
      policy,
      canonicalContactId: input.canonicalContactId,
      channelId: input.channelId,
      ...(input.explicitHumanInboundCompanionId
        ? { explicitHumanInboundCompanionId: input.explicitHumanInboundCompanionId }
        : {}),
    });
    const excludedCompanionIds = new Set<CompanionId>();
    const conversationKey = JSON.stringify([
      input.canonicalContactId,
      satellite.sessionId,
    ]);
    const explicitAddressedCompanionId = input.explicitHumanInboundCompanionId
      ?? satellite.addressedCompanionId;

    for (;;) {
      const acquisition = this.sharedSatelliteResponseArbiter.acquire({
        satelliteId: satellite.satelliteId,
        conversationKey,
        policy,
        eligibility,
        ...(explicitAddressedCompanionId
          ? { explicitAddressedCompanionId }
          : {}),
        excludedCompanionIds,
      });
      if (!acquisition.acquired) {
        // A refused shared-satellite turn used to vanish (empty 200, no line
        // anywhere); the hub cannot tell that from a broken model. Name the
        // disposition (psfn-framework-rqm6t).
        await this.ports.audit('satellite.response.refused', 'DENY', {
          channelId: input.channelId,
          satelliteId: input.satellite.satelliteId,
          reason: acquisition.reason,
          explicitAddressed: Boolean(explicitAddressedCompanionId),
        });
        return this.sharedSatelliteChatNoOp(input.channelId);
      }
      const { lease } = acquisition;
      try {
        const route = this.ports.requireReadyCompanionRoute(
          `satellite:${satellite.satelliteId}`,
          lease.companionId,
        );
        this.sharedSatelliteChatRequests.set(params.requestId, lease.companionId);
        const effectiveTimeoutMs = Math.min(
          input.timeoutMs,
          Math.max(1, lease.expiresAtMs - Date.now()),
        );
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('Shared-satellite chat request timed out')),
            effectiveTimeoutMs,
          );
          timeoutHandle.unref();
        });
        let raced: unknown;
        try {
          raced = await Promise.race([
            route.client.request('api.chat.completion', params),
            timeout,
          ]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
        // d269: shared-satellite chat replies cross the same reverse-RPC seam;
        // scan before arbitration reads the content.
        const rawResult = await this.ports.inspectAgentReply(
          'api.chat.completion',
          raced,
        ) as ApiChatCompletionRpcResult;
        const result: ApiChatCompletionRpcResult = rawResult.ok
          ? {
              ...rawResult,
              response: {
                ...rawResult.response,
                companionId: lease.companionId,
              },
            }
          : rawResult;
        if (!result.ok) {
          if (result.error.type === 'request_timeout') {
            this.sharedSatelliteResponseArbiter.timeout(
              lease.leaseId,
              'agent_request_timeout',
            );
            excludedCompanionIds.add(lease.companionId);
            continue;
          }
          this.sharedSatelliteResponseArbiter.complete(
            lease.leaseId,
            'release',
            `agent_error:${result.error.type}`,
          );
          return result;
        }
        if (result.response.content.trim()) {
          if (!this.sharedSatelliteResponseArbiter.complete(lease.leaseId, 'speech')) {
            await this.ports.audit('satellite.response.refused', 'DENY', {
              channelId: input.channelId,
              satelliteId: input.satellite.satelliteId,
              reason: 'speech_lease_lost',
              explicitAddressed: Boolean(explicitAddressedCompanionId),
            });
            return this.sharedSatelliteChatNoOp(input.channelId);
          }
          return result;
        }
        if (result.response.noReply?.disposition !== 'intentional_no_reply') {
          this.sharedSatelliteResponseArbiter.complete(
            lease.leaseId,
            'release',
            'unmarked_empty_response',
          );
          return {
            ok: false,
            error: {
              status: 502,
              type: 'empty_response',
              message: 'Shared-satellite agent returned empty content without an intentional disposition',
            },
          };
        }
        this.sharedSatelliteResponseArbiter.complete(
          lease.leaseId,
          'decline',
          'structured_intentional_no_reply',
        );
        if (lease.priority === 'explicit_address' || lease.priority === 'active_conversation') {
          return result;
        }
        excludedCompanionIds.add(lease.companionId);
      } catch (error) {
        const timedOut = toErrorMessage(error).toLowerCase().includes('timed out');
        if (timedOut) {
          this.sharedSatelliteResponseArbiter.timeout(lease.leaseId, 'model_timeout');
          excludedCompanionIds.add(lease.companionId);
          continue;
        }
        this.sharedSatelliteResponseArbiter.complete(lease.leaseId, 'release', 'model_error');
        throw error;
      } finally {
        if (this.sharedSatelliteChatRequests.get(params.requestId) === lease.companionId) {
          this.sharedSatelliteChatRequests.delete(params.requestId);
        }
      }
    }
  }

  async cancelSharedSatelliteChatCompletion(
    requestId: string,
    params: unknown,
    timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  ): Promise<unknown> {
    const companionId = this.sharedSatelliteChatRequests.get(requestId);
    if (!companionId) return { cancelled: false };
    return await this.ports.requestCompanionAgent(
      companionId,
      'api.chat.cancel',
      params,
      timeoutMs,
    );
  }

  async requestSharedSatelliteVoiceStream(
    message: SubstrateMessage,
    satellite: SatelliteRoutingMetadata & {
      sharedDevice: NonNullable<SatelliteRoutingMetadata['sharedDevice']>;
    },
    options: VoiceStreamRequestOptions,
  ): Promise<VoiceHandleMessageResult> {
    const policy = satellite.sharedDevice;
    const canonicalContactId = message.routing?.canonicalContactId?.trim();
    if (!canonicalContactId) {
      throw new Error('Shared-satellite response arbitration requires exact canonical partner identity');
    }
    const eligibility = await this.resolveSharedSatelliteEligibility({
      policy,
      canonicalContactId,
      channelId: message.channelId,
    });
    const excludedCompanionIds = new Set<CompanionId>();
    const addressedCompanionId = satellite.addressedCompanionId;
    const conversationKey = JSON.stringify([canonicalContactId, satellite.sessionId]);

    for (;;) {
      const acquisition = this.sharedSatelliteResponseArbiter.acquire({
        satelliteId: satellite.satelliteId,
        conversationKey,
        policy,
        eligibility,
        ...(addressedCompanionId ? { explicitAddressedCompanionId: addressedCompanionId } : {}),
        excludedCompanionIds,
      });
      if (!acquisition.acquired) {
        return this.sharedSatelliteNoOp(message.channelId);
      }
      const { lease } = acquisition;
      try {
        const route = this.ports.requireReadyCompanionRoute(
          `satellite:${satellite.satelliteId}`,
          lease.companionId,
        );
        const screenedMessage = options.screenMessageForCompanion
          ? await options.screenMessageForCompanion(message, lease.companionId)
          : message;
        const result = await requestAgentVoiceStream({
          client: route.client,
          message: screenedMessage,
          options: {
            ...options,
            timeoutMs: Math.min(
              options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
              Math.max(1, lease.expiresAtMs - Date.now()),
            ),
          },
          wyomingShardRouting: this.ports.wyomingShardRouting,
          companionId: lease.companionId,
          nextRequestCounter: () => this.ports.nextStreamRequestCounter(),
          // d269: main-reply canary scan at the reverse-RPC seam.
          inspectReply: (replyMethod, replyResult) => this.ports.inspectAgentReply(replyMethod, replyResult),
        });
        if (result.content.trim()) {
          if (!this.sharedSatelliteResponseArbiter.complete(lease.leaseId, 'speech')) {
            return this.sharedSatelliteNoOp(message.channelId);
          }
          const attachments = materializeGatewayAttachments(
            result.attachments,
            this.ports.resolveConnectionWorkspacePath(route.conn),
          );
          return { ...result, ...(attachments ? { attachments } : {}) };
        }
        if (result.disposition !== 'decline' && result.disposition !== 'no_op') {
          this.sharedSatelliteResponseArbiter.complete(
            lease.leaseId,
            'release',
            'unmarked_empty_response',
          );
          throw new Error('Shared-satellite agent returned empty content without a structured disposition');
        }
        this.sharedSatelliteResponseArbiter.complete(
          lease.leaseId,
          result.disposition,
          result.disposition === 'decline'
            ? 'structured_intentional_no_reply'
            : 'structured_no_op',
        );
        if (lease.priority === 'explicit_address' || lease.priority === 'active_conversation') {
          return this.sharedSatelliteNoOp(message.channelId);
        }
        excludedCompanionIds.add(lease.companionId);
      } catch (error) {
        const timedOut = toErrorMessage(error).toLowerCase().includes('timed out');
        if (timedOut) {
          this.sharedSatelliteResponseArbiter.timeout(lease.leaseId, 'model_timeout');
        } else {
          this.sharedSatelliteResponseArbiter.complete(
            lease.leaseId,
            'release',
            'model_error',
          );
        }
        if (!timedOut) throw error;
        excludedCompanionIds.add(lease.companionId);
      }
    }
  }

  private sharedSatelliteNoOp(channelId: string): VoiceHandleMessageResult {
    return {
      content: '',
      channelId,
      model: 'shared-satellite-deterministic-no-op',
      durationMs: 0,
    };
  }

  private sharedSatelliteChatNoOp(channelId: string): ApiChatCompletionRpcResult {
    return {
      ok: true,
      response: {
        content: '',
        channelId,
        inputTokens: 0,
        outputTokens: 0,
        disposition: 'no_op',
      },
    };
  }

  private async resolveSharedSatelliteEligibility(
    input: {
      policy: NonNullable<SatelliteRoutingMetadata['sharedDevice']>;
      canonicalContactId: string;
      channelId: string;
      explicitHumanInboundCompanionId?: CompanionId;
    },
  ): Promise<SharedSatelliteEligibility[]> {
    this.ports.refreshConnectionHealth();
    return await Promise.all(input.policy.emanationMemberIds.map(async (
      companionId,
    ): Promise<SharedSatelliteEligibility> => {
      const availability = this.ports.icpAutonomyBroker
        ? await this.ports.icpAutonomyBroker.readOwnAvailability(companionId)
        : undefined;
      // A deployment with no ICP autonomy broker (every one-companion fleet)
      // has no availability fence to consult; it is not "unavailable"
      // (psfn-framework-5ybt1).
      const availabilityUnfenced = this.ports.icpAutonomyBroker === null;
      const availabilityState = availability?.lease?.state;
      const connection = this.ports.resolveReadyCompanionConnection(companionId);
      const client = connection ? this.ports.rpcClients.get(connection) : undefined;
      const nowMs = Date.now();
      const isExplicitHumanInbound = input.explicitHumanInboundCompanionId === companionId;
      const availabilityLeaseIsAbsent = availability?.control === 'missing'
        || availability?.control === 'expired';
      const explicitHumanAvailabilityAllows = isExplicitHumanInbound
        && availability !== undefined
        && (availabilityLeaseIsAbsent || availabilityState === 'resting');
      // A satellite turn that names its own in-world speaker carries no
      // canonical contact for the operator (satellite-registry resolves it to
      // ''); contact-level fatigue then has nothing to consult and the agent
      // decoder would reject the empty id. Speaker fatigue (machine
      // intelligence, strangers) is evaluated inside the turn pipeline instead.
      const contactFatigueApplies = input.canonicalContactId.length > 0;
      let fatigueAllows = !contactFatigueApplies;
      if (client && contactFatigueApplies) {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error('Satellite response eligibility timed out')),
              input.policy.responseLease.durationMs,
            );
            timeoutHandle.unref();
          });
          const result = await Promise.race([
            client.request('satellite.response.eligibility', {
              canonicalContactId: input.canonicalContactId,
              channelId: input.channelId,
            }),
            timeout,
          ]);
          fatigueAllows = isRecord(result)
            && Object.keys(result).length === 1
            && result.fatigueAllows === true;
        } catch {
          fatigueAllows = false;
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      }
      return {
        companionId,
        availabilityAllows: connection !== null
          && (availabilityUnfenced
            || availability?.eligible === true
            || explicitHumanAvailabilityAllows),
        fatigueAllows,
        quietHoursAllows: isExplicitHumanInbound
          || this.ports.options.sharedSatelliteQuietHoursAllows?.(nowMs, companionId) === true,
        restAllows: availabilityLeaseIsAbsent
          || ((isExplicitHumanInbound || availabilityState !== 'resting')
            && availabilityState !== 'do_not_disturb'),
        // This is an explicit human-partner turn, not an autonomous Pack Task.
        taskAllows: true,
        deviceAllows: input.policy.emanationMemberIds.includes(companionId),
      };
    }));
  }

  private async recordSharedSatelliteLeaseAudit(
    event: SharedSatelliteLeaseAuditEvent,
  ): Promise<void> {
    await this.ports.audit('satellite.response.lease', 'ALLOW', { ...event });
    await this.ports.options.eventBus.emit('satellite.response.lease', event);
  }
}
