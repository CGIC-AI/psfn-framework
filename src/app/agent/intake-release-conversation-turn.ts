import type { AgentResponse, Attachment, ChannelType, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';
import type { SessionEntry } from '../../core/session/types.js';
import { snapshotIntakeEnvelope } from '../../shared/contracts/intake-envelope.js';
import { formatIntakeReleaseNotice } from '../../core/cogsec/intake-firewall-notice-templates.js';
import type {
  IntakeReleaseRedeliveryInput,
  IntakeReleaseRedeliveryPort,
} from '../../operator/garden/services/intake-quarantine-service.js';
import { createDiscordDeliveryCheckpoint, deliverDiscordReply } from './discord-reply-delivery.js';

export interface IntakeReleaseConversationTurnDeps {
  agent: {
    handleMessage(message: SubstrateMessage): Promise<AgentResponse>;
  };
  delivery: {
    sendText(channelId: string, content: string): Promise<void>;
    sendMedia(channelId: string, attachment: Attachment): Promise<void>;
  };
  sessions: {
    resolveSessionForIngress(sourceChannelId: string): string;
    findRecordedSourceMessageEntry(
      channelId: string,
      sourceMessageId: string,
    ): SessionEntry | null;
  };
  classifyChannelPrivacy(channelId: string): ChannelPrivacy;
}

function releaseMessageId(input: IntakeReleaseRedeliveryInput): string {
  return `intake-release:${input.envelope.id}:${input.action}`;
}

function resolveReleaseChannelType(
  sourceChannelId: string,
  originRef: string,
): ChannelType | null {
  if (originRef.startsWith('discord:') || /^[0-9]{15,22}$/u.test(sourceChannelId)) {
    return 'discord';
  }
  return null;
}

/**
 * Re-enters a released quarantine item through the ordinary system-authored
 * turn pipeline. The firewall remains the speaker; the original bytes are
 * quoted inside its provenance-marked notice and are never attributed to the
 * contact whose ingress was held.
 */
export function createIntakeReleaseConversationTurn(
  deps: IntakeReleaseConversationTurnDeps,
): IntakeReleaseRedeliveryPort {
  return async (input) => {
    const sourceChannelId = input.sourceChannelId?.trim();
    if (!sourceChannelId) {
      return { delivered: false, reason: 'no source channel was recorded on the held item' };
    }
    const originHop = input.envelope.provenance[0];
    if (!originHop) {
      return { delivered: false, reason: 'held item is missing provenance origin hop' };
    }
    const channelType = resolveReleaseChannelType(sourceChannelId, originHop.ref);
    if (!channelType) {
      return {
        delivered: false,
        reason: `source channel '${sourceChannelId}' has no supported conversation transport`,
      };
    }

    const logicalSessionId = deps.sessions.resolveSessionForIngress(sourceChannelId);
    const sourceMessageId = releaseMessageId(input);
    const existing = deps.sessions.findRecordedSourceMessageEntry(
      logicalSessionId,
      sourceMessageId,
    );
    if (existing) {
      if (existing.role !== 'system' || existing.authorId !== 'system:intake-firewall') {
        return {
          delivered: false,
          reason: 'release source-message id is already bound to a non-firewall transcript entry',
        };
      }
      return {
        delivered: true,
        channelId: sourceChannelId,
        logicalSessionId,
        entryId: existing.id,
      };
    }

    const notice = formatIntakeReleaseNotice({
      sourceClass: input.envelope.sourceClass,
      originRef: originHop.ref,
      reviewedByActor: input.actor,
      reviewedAtIso: new Date(input.atMs).toISOString(),
      sanitized: input.action === 'release_sanitized',
      truncated: input.rawTextTruncated,
      content: input.content,
    });
    const message: SubstrateMessage = {
      id: sourceMessageId,
      channelId: sourceChannelId,
      channelType,
      authorId: 'system:intake-firewall',
      authorName: 'Intake firewall',
      content: notice,
      timestamp: new Date(input.atMs),
      routing: {
        channelPrivacy: deps.classifyChannelPrivacy(sourceChannelId),
        intakeEnvelopes: [snapshotIntakeEnvelope(input.envelope, { kind: 'body' })],
      },
    };

    const response = await deps.agent.handleMessage(message);
    const recorded = deps.sessions.findRecordedSourceMessageEntry(
      logicalSessionId,
      sourceMessageId,
    );
    if (!recorded) {
      return {
        delivered: false,
        reason: 'system turn completed without a source-bound conversation entry',
      };
    }
    if (recorded.role !== 'system'
      || recorded.authorId !== 'system:intake-firewall'
      || !recorded.metadata?.includes(input.envelope.id)) {
      return {
        delivered: false,
        reason: 'system turn entry lost firewall authorship or intake provenance',
      };
    }

    await deliverDiscordReply(
      sourceChannelId,
      createDiscordDeliveryCheckpoint(response, [sourceMessageId]),
      {
        sendText: deps.delivery.sendText,
        sendMedia: deps.delivery.sendMedia,
        onTextDelivered: () => {},
      },
    );

    return {
      delivered: true,
      channelId: sourceChannelId,
      logicalSessionId,
      entryId: recorded.id,
    };
  };
}
