// ── Follow-up ingress + completion-notice routing (charter 12.1 split, emh3p.2) ──
// Queued follow-up ingress (whisper/system-note/user variants) and terminal
// child completion-notice routing, extracted from SubstrateAgent. Neither
// path creates conversational speech or outbound IO without passing the
// existing turn-session recording and message-class rules.

import type { Agent } from '../../../boundary/pi-agent/index.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { TurnRunReservation } from './turn-run-reservation.js';
import type { TurnQueueIngressCoordinator } from './turn-queue-ingress.js';
import type { TurnSupportRuntime } from './turn-support-runtime.js';
import type { TurnSessionIdentity } from './turn-execution/contracts.js';
import type { ResolvedAuthorContext } from './runtime-context.js';
import {
  INTENTION_FOLLOW_UP_AUTHOR_ID,
  INTENTION_FOLLOW_UP_AUTHOR_NAME,
} from '../../intention/appraisal.js';
import {
  renderCompletionNoticeLines,
  type CompletionNoticeBuffer,
  type CompletionNoticeDeliveryDisposition,
  type CompletionNoticeDeliveryInput,
} from '../completion-notices.js';
import {
  MESSAGE_CLASSES,
} from '../message-classes.js';
import type { InternalWhisperMessage } from '../messages.js';
import { formatAttributedSystemContent } from '../../session/entry-attribution.js';
import { createTurnId } from '../../turns/id.js';
import { createComponentLogger } from '../../../shared/logger.js';

const log = createComponentLogger('FollowUpIngress');


export interface FollowUpIngressDeps {
  agent: Pick<Agent, 'followUp'>;
  turnRunReservation: TurnRunReservation;
  turnQueueIngress: TurnQueueIngressCoordinator;
  turnSupportRuntime: TurnSupportRuntime;
  completionNotices: CompletionNoticeBuffer;
  requireActiveTurnSessionIdentity: () => TurnSessionIdentity;
  resolveAuthorContext: (message: SubstrateMessage) => Promise<ResolvedAuthorContext>;
}

export class FollowUpIngressRouter {
  constructor(private readonly deps: FollowUpIngressDeps) {}

  async followUp(message: SubstrateMessage): Promise<void> {
    return this.deps.turnRunReservation.runIngress({
      kind: 'queued-ingress',
      sourceId: message.id,
      ingress: 'follow-up',
    }, async ({ deferredFromExclusive }) => {
      // Claim the fresh-ordinary FIFO slot synchronously, before author
      // resolution, so concurrent idle inputs cannot invert arrival order.
      const slot = this.deps.turnQueueIngress.reserveFreshOrdinarySlot();
      try {
        if (!deferredFromExclusive && await this.tryQueueFollowUpOnActiveOrdinaryRun(message)) return;
        if (message.authorId === INTENTION_FOLLOW_UP_AUTHOR_ID) {
          this.deps.turnQueueIngress.deferInternalFollowUp(this.createInternalWhisperMessage(message));
          return;
        }
        await slot.run(message);
      } finally {
        slot.dispose();
      }
    });
  }

  /**
   * Route a terminal child result to its originating companion context.
   * A matching active parent turn receives a private internal whisper; idle or
   * differently-scoped work is buffered by logical session for the next
   * ordinary turn. Neither path creates conversational speech or outbound IO.
   */
  async deliverCompletionNotice(
    input: CompletionNoticeDeliveryInput,
  ): Promise<CompletionNoticeDeliveryDisposition> {
    const sourceChannelId = input.sourceChannelId.trim();
    const logicalSessionId = input.logicalSessionId.trim();
    if (!sourceChannelId || !logicalSessionId) {
      throw new Error('Completion notice delivery requires source and logical session ids');
    }
    return this.deps.turnRunReservation.runIngress({
      kind: 'queued-ingress',
      sourceId: input.notice.handoffId,
      ingress: 'completion',
    }, async ({ deferredFromExclusive }) => {
      const activeIdentity = this.deps.turnSupportRuntime.getActiveTurnSessionIdentity();
      if (!deferredFromExclusive
        && this.deps.turnQueueIngress.canQueueIntoActiveOrdinaryRun()
        && activeIdentity?.logicalSessionId === logicalSessionId) {
        this.deps.agent.followUp({
          role: 'custom',
          type: 'internalWhisper',
          messageClass: MESSAGE_CLASSES.internalWhisper,
          content: renderCompletionNoticeLines(input.notice),
          speakerName: 'Task report',
          timestamp: Date.now(),
        } satisfies InternalWhisperMessage);
        return 'active_nudge';
      }
      this.deps.completionNotices.register(logicalSessionId, input.notice);
      return 'buffered';
    });
  }

  private createInternalWhisperMessage(message: SubstrateMessage): InternalWhisperMessage {
    return {
      role: 'custom',
      type: 'internalWhisper',
      messageClass: MESSAGE_CLASSES.internalWhisper,
      content: message.content,
      speakerName: message.authorName.trim() || INTENTION_FOLLOW_UP_AUTHOR_NAME,
      timestamp: Date.now(),
    };
  }

  private async tryQueueFollowUpOnActiveOrdinaryRun(
    message: SubstrateMessage,
  ): Promise<boolean> {
    if (message.authorId === INTENTION_FOLLOW_UP_AUTHOR_ID) {
      if (!this.deps.turnQueueIngress.canQueueIntoActiveOrdinaryRun()) return false;
      this.deps.agent.followUp(this.createInternalWhisperMessage(message));
      log.debug('Queued follow-up', {
        channelId: message.channelId,
        internalKind: 'whisper',
      });
      return true;
    }

    const isSystemOriginated = message.authorId.startsWith('system:');
    const turnId = createTurnId();
    const systemContent = isSystemOriginated
      ? formatAttributedSystemContent(message.content, message.authorName)
      : message.content;
    const authorContext: ResolvedAuthorContext | null = isSystemOriginated
      ? null
      : await this.deps.resolveAuthorContext(message);
    if (!this.deps.turnQueueIngress.canQueueIntoActiveOrdinaryRun()) return false;
    const turnSessionIdentity = this.deps.requireActiveTurnSessionIdentity();
    if (isSystemOriginated) {
      this.deps.turnSupportRuntime.recordSystemMessage(
        message,
        turnSessionIdentity,
        turnId,
        message.id,
        systemContent,
      );
    } else {
      if (!authorContext) {
        throw new Error('External follow-up requires resolved ordinary author context');
      }
      this.deps.turnSupportRuntime.recordUserMessage(
        message,
        turnSessionIdentity,
        turnId,
        message.id,
        authorContext.trustLevel,
        authorContext.subjectIdentityKey ?? authorContext.canonicalContactKey,
      );
    }
    this.deps.agent.followUp(isSystemOriginated
      ? {
        role: 'custom',
        type: 'systemNote',
        messageClass: MESSAGE_CLASSES.systemNote,
        content: systemContent,
        timestamp: Date.now(),
      }
      : {
        role: 'user',
        content: systemContent,
        timestamp: Date.now(),
      } satisfies UserMessage);
    log.debug('Queued follow-up', {
      channelId: message.channelId,
      systemOriginated: isSystemOriginated,
    });
    return true;
  }
}
