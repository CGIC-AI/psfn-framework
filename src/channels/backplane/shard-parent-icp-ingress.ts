import { randomUUID } from 'node:crypto';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import type {
  PolicyGovernedShardParentIcpDeliveryPort,
  ShardParentIcpEnvelope,
  ShardParentIcpRoutingMetadata,
} from '../../shared/contracts/shard-parent-icp.js';
import {
  formatShardParentIcpChannelId,
  parseShardParentIcpEnvelope,
} from '../../shared/contracts/shard-parent-icp.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

export interface OrdinaryCompanionTurnIngress {
  handleMessage(message: SubstrateMessage): Promise<unknown>;
  waitForIdle(): Promise<void>;
}

export interface PolicyGovernedShardParentIcpDeliveryOptions {
  parentCompanionId: CompanionId;
  intakeScreening: Pick<IntakeScreeningService, 'screen'> | null;
  agentLoop: OrdinaryCompanionTurnIngress;
  idFactory?: () => string;
  now?: () => Date;
}

const log = createComponentLogger('ShardParentIcpIngress');
const AGENT_BUSY_PATTERN = /already processing a prompt/i;

/**
 * Narrow local adapter for ordinary shard→parent ICP.
 *
 * This is intentionally not a relay transport: it has no peer registration
 * surface and routes only to its bound parent. It enters the same
 * SubstrateAgent turn boundary as ordinary inbound companion messages after
 * applying the configured cognition-intake policy as `subagent_output`.
 */
export function createPolicyGovernedShardParentIcpDelivery(
  options: PolicyGovernedShardParentIcpDeliveryOptions,
): PolicyGovernedShardParentIcpDeliveryPort {
  const parentCompanionId = createCompanionId(
    options.parentCompanionId,
    'Shard-parent ICP local parent companionId',
  );
  const idFactory = options.idFactory ?? (() => `shard-parent-icp-${randomUUID()}`);
  const now = options.now ?? (() => new Date());
  const promptQueue: SubstrateMessage[] = [];
  let pumpActive = false;

  const promptWhenIdle = async (message: SubstrateMessage): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await options.agentLoop.handleMessage(message);
        return;
      } catch (error) {
        if (!(error instanceof Error) || !AGENT_BUSY_PATTERN.test(error.message)) {
          throw error;
        }
        log.warn('Parent companion busy; holding shard ICP until the active turn finishes', {
          attempt,
          messageId: message.id,
        });
        await options.agentLoop.waitForIdle();
      }
    }
  };

  const pumpPromptQueue = async (): Promise<void> => {
    if (pumpActive) return;
    pumpActive = true;
    try {
      while (promptQueue.length > 0) {
        const message = promptQueue.shift();
        if (!message) continue;
        try {
          await promptWhenIdle(message);
        } catch (error) {
          log.error('Failed to process queued shard-parent ordinary ICP message', {
            messageId: message.id,
            error: toErrorMessage(error),
          });
        }
      }
    } finally {
      pumpActive = false;
      if (promptQueue.length > 0) {
        void pumpPromptQueue();
      }
    }
  };

  return {
    async deliverOrdinaryIcp(envelope: ShardParentIcpEnvelope): Promise<void> {
      const normalized = validateInboundEnvelope(envelope, parentCompanionId);
      const channelId = formatShardParentIcpChannelId(normalized);
      const messageId = idFactory().trim();
      if (!messageId) {
        throw new Error('Shard-parent ICP message id factory returned an empty id');
      }
      const timestamp = now();
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
        throw new Error('Shard-parent ICP delivery timestamp is invalid');
      }

      let content = normalized.content;
      let intakeEnvelopes:
        readonly import('../../shared/contracts/intake-envelope.js').IntakeEnvelopeSnapshot[]
        | undefined;
      if (options.intakeScreening) {
        const screened = await options.intakeScreening.screen(content, {
          sourceClass: 'subagent_output',
          origin: {
            ref: [
              'shard-parent-icp',
              normalized.routingCompanionId,
              normalized.lineage.shardId,
              normalized.direction,
            ].join(':'),
          },
          scope: 'context',
          sourceChannelId: channelId,
        });
        content = screened.effectiveText;
        intakeEnvelopes = Object.freeze([screened.snapshot]);
      }

      const routing: ShardParentIcpRoutingMetadata = Object.freeze({
        schemaVersion: 1,
        routingCompanionId: normalized.routingCompanionId,
        lineage: Object.freeze({ ...normalized.lineage }),
        direction: normalized.direction,
      });
      const message: SubstrateMessage = {
        id: messageId,
        channelId,
        channelType: 'companion',
        authorId: `shard:${normalized.lineage.shardId}`,
        authorName: 'Shard',
        content,
        timestamp: new Date(timestamp.getTime()),
        isDirectMessage: true,
        routing: {
          source: 'companion',
          authorIsMachineIntelligence: true,
          shardParentIcp: routing,
          ...(intakeEnvelopes ? { intakeEnvelopes } : {}),
        },
      };
      promptQueue.push(message);
      void pumpPromptQueue();
    },
  };
}

function validateInboundEnvelope(
  envelope: ShardParentIcpEnvelope,
  localParentCompanionId: CompanionId,
): ShardParentIcpEnvelope {
  const normalized = parseShardParentIcpEnvelope(envelope);
  if (normalized.routingCompanionId !== localParentCompanionId) {
    throw new Error('Shard-parent ICP denied for a foreign parent companion');
  }
  if (normalized.direction !== 'shard_to_parent') {
    throw new Error('Parent cognition ingress only accepts shard-to-parent ordinary ICP');
  }
  return normalized;
}
