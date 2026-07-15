import type { LLMProviderPort } from '../agent/contracts.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { SessionManager } from './manager.js';

const log = createComponentLogger('CompressionGuidelineEvolution');
const COMPACTION_GUIDELINE_REVIEW_ACTION_KIND = 'compaction-guideline-review';

export interface CompressionGuidelineEvolutionInput {
  sessionManager: SessionManager;
  message: Pick<SubstrateMessage, 'channelId' | 'id'>;
  response: Pick<AgentResponse, 'content'>;
}

export interface CompressionGuidelineEvolutionPort {
  captureAndReview(input: CompressionGuidelineEvolutionInput): Promise<void>;
}

export function createCompressionGuidelineEvolution(options: {
  eligibilityGate: EligibilityGate;
  llmProvider: LLMProviderPort;
}): CompressionGuidelineEvolutionPort {
  let reviewTail = Promise.resolve();

  const review = async (sessionManager: SessionManager): Promise<void> => {
    const eligibility = options.eligibilityGate.evaluate(
      {
        kind: 'post_turn.action',
        actionKind: COMPACTION_GUIDELINE_REVIEW_ACTION_KIND,
      },
      { requiredTokens: ['memory.write'] },
    );
    if (!eligibility.allowed) {
      log.debug('Compression guideline review skipped', {
        reason: eligibility.reasonCode,
        reviewedFailureCount: 0,
      });
      return;
    }

    const result = await sessionManager.runPeriodicCompressionGuidelineUpdate(options.llmProvider);
    if (result.status === 'updated') {
      log.info('Compression guideline updated from shard failure review', {
        version: result.version,
        reviewedFailureCount: result.reviewedFailureCount,
      });
      return;
    }
    log.debug('Compression guideline review skipped', {
      reason: result.reason,
      reviewedFailureCount: result.reviewedFailureCount,
    });
  };

  return {
    async captureAndReview({ sessionManager, message, response }): Promise<void> {
      if (!message.channelId.startsWith('shard:')) return;
      const captured = sessionManager.recordCompressionFailureFromResponse(
        message.channelId,
        message.id,
        response.content,
      );
      if (!captured) return;

      log.info('Captured shard compression failure signal for guideline evolution', {
        channelId: message.channelId,
        sourceMessageId: message.id,
      });

      const queued = reviewTail.then(() => review(sessionManager));
      reviewTail = queued.catch(() => undefined);
      await queued;
    },
  };
}
