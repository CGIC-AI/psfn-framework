import type { EventBus } from '../../../event-bus.js';
import { DEFAULT_COMPANION_NAME } from '../../../identity/companion-naming.js';
import type {
  AdminAuditActionType,
  AdminAuditActor,
  AdminAuditDecision,
} from '../types.js';

const AGENT_IDENTITY_EDIT_TOOLS = new Set([
  'prompt_layer_update',
  'prompt_layer_toggle',
  'persona_update',
]);

export interface ActiveToolInvocation {
  toolName: string;
  channelId: string;
  startedAt: number;
}

export interface AuditTimelineAppender {
  (
    actionType: AdminAuditActionType,
    decision: AdminAuditDecision,
    narrative: string,
    details?: Array<string | null | undefined>,
    actor?: AdminAuditActor,
  ): void;
}

export function registerAuditTimelineSources(options: {
  eventBus: EventBus;
  activeToolInvocations: Map<string, ActiveToolInvocation>;
  appendAuditTimelineEntry: AuditTimelineAppender;
  resolveCompanionName?: () => string;
  now?: () => number;
}): void {
  const {
    eventBus,
    activeToolInvocations,
    appendAuditTimelineEntry,
    resolveCompanionName = () => DEFAULT_COMPANION_NAME,
    now = () => Date.now(),
  } = options;

  eventBus.on('agent.tool.start', ({ toolCallId, toolName, channelId }) => {
    activeToolInvocations.set(toolCallId, {
      toolName,
      channelId,
      startedAt: now(),
    });
  });

  eventBus.on('agent.tool.end', ({ toolCallId, toolName, channelId, isError, shardId }) => {
    const active = activeToolInvocations.get(toolCallId);
    if (active) {
      activeToolInvocations.delete(toolCallId);
    }
    const durationMs = active ? Math.max(0, now() - active.startedAt) : null;
    const decision: AdminAuditDecision = isError ? 'denied' : 'allowed';
    const toolLabel = active?.toolName ?? toolName;
    const channelLabel = active?.channelId ?? channelId;
    const companionName = resolveCompanionName();
    appendAuditTimelineEntry(
      'tool_invocation',
      decision,
      isError
        ? `${companionName} attempted tool "${toolLabel}" in ${channelLabel}, but it failed.`
        : `${companionName} completed tool "${toolLabel}" in ${channelLabel}.`,
      [
        `callId=${toolCallId}`,
        shardId ? `shard=${shardId}` : null,
        durationMs !== null ? `durationMs=${durationMs}` : null,
      ],
      'companion',
    );

    if (AGENT_IDENTITY_EDIT_TOOLS.has(toolLabel)) {
      appendAuditTimelineEntry(
        'identity_edit',
        decision,
        isError
          ? `${companionName} attempted identity edit via "${toolLabel}" in ${channelLabel}, but it failed.`
          : `${companionName} edited identity via "${toolLabel}" in ${channelLabel}.`,
        [
          `callId=${toolCallId}`,
          shardId ? `shard=${shardId}` : null,
          durationMs !== null ? `durationMs=${durationMs}` : null,
        ],
        'companion',
      );
    }
  });

  eventBus.on('memory.extraction.end', (event) => {
    const writeCount = event.writeCount ?? 0;
    const deduplicatedCount = event.deduplicatedCount ?? 0;
    const supersededCount = event.supersededCount ?? 0;
    if (writeCount <= 0 && deduplicatedCount <= 0 && supersededCount <= 0) return;
    const decision: AdminAuditDecision = writeCount > 0 ? 'allowed' : 'denied';
    const companionName = resolveCompanionName();
    appendAuditTimelineEntry(
      'memory_mutation',
      decision,
      writeCount > 0
        ? `${companionName} mutated memory in ${event.channelId}: wrote ${writeCount} memory entries.`
        : `${companionName} attempted a memory mutation in ${event.channelId}, but no entries were written.`,
      [
        `accepted=${event.acceptedCount ?? 0}`,
        `rejected=${event.rejectedCount ?? 0}`,
        `deduplicated=${deduplicatedCount}`,
        `superseded=${supersededCount}`,
      ],
      'companion',
    );
  });

  eventBus.on('message.sent', ({ response }) => {
    const companionName = resolveCompanionName();
    appendAuditTimelineEntry(
      'external_action',
      'allowed',
      `${companionName} sent an external response to ${response.channelId}.`,
      [
        `model=${response.metadata.model}`,
        `durationMs=${response.metadata.durationMs}`,
      ],
      'companion',
    );
  });

  eventBus.on('broadcast.approval.required', (event) => {
    appendAuditTimelineEntry(
      'external_action',
      'denied',
      `Broadcast draft in ${event.channelId} was held for operator approval.`,
      [
        `scope=${event.visibilityScope}`,
        `signals=${event.signals.join(',') || 'none'}`,
        `draftLength=${event.draftLength}`,
      ],
      'companion',
    );
  });

  eventBus.on('broadcast.provenance', (event) => {
    appendAuditTimelineEntry(
      'external_action',
      event.risky && !event.operatorApproval ? 'denied' : 'allowed',
      `Broadcast provenance logged for ${event.channelId}.`,
      [
        `scope=${event.visibilityScope}`,
        `signals=${event.signals.join(',') || 'none'}`,
        `provenanceRefs=${event.provenanceRefs.length}`,
        `contextMessages=${event.contextMessageCount}`,
        `memoryContextChars=${event.memoryContextChars}`,
      ],
      'companion',
    );
  });

  eventBus.on('external.telemetry.ingested', ({ event }) => {
    appendAuditTimelineEntry(
      'external_action',
      'allowed',
      `External telemetry "${event.eventType}" from ${event.source} was ingested.`,
      [
        event.channelId ? `channelId=${event.channelId}` : null,
        event.scope ? `scope=${event.scope}` : null,
        `eventId=${event.id}`,
      ],
      'companion',
    );
  });

  eventBus.on('wyoming.session.start', (event) => {
    appendAuditTimelineEntry(
      'external_action',
      'allowed',
      `Wyoming session "${event.sessionId}" opened on ${event.connectionId}.`,
      [
        `activeSessions=${event.activeSessions}`,
        `maxSessions=${event.maxSessions}`,
      ],
      'companion',
    );
  });

  eventBus.on('wyoming.session.end', (event) => {
    const deniedReason = event.reason.includes('policy')
      || event.reason.includes('error')
      || event.reason.includes('timeout');
    appendAuditTimelineEntry(
      'external_action',
      deniedReason ? 'denied' : 'allowed',
      deniedReason
        ? `Wyoming session "${event.sessionId}" ended with policy/error reason "${event.reason}".`
        : `Wyoming session "${event.sessionId}" ended on ${event.connectionId}.`,
      [
        `reason=${event.reason}`,
        `durationMs=${event.durationMs}`,
        `activeSessions=${event.activeSessions}`,
      ],
      'companion',
    );
  });

  eventBus.on('wyoming.policy.violation', (event) => {
    appendAuditTimelineEntry(
      'external_action',
      'denied',
      `Wyoming policy violation ${event.code} on ${event.connectionId}.`,
      [
        `scope=${event.scope}`,
        event.sessionId ? `sessionId=${event.sessionId}` : null,
        event.eventType ? `eventType=${event.eventType}` : null,
        event.limit !== undefined ? `limit=${event.limit}` : null,
        event.observed !== undefined ? `observed=${event.observed}` : null,
        `action=${event.action}`,
      ],
      'companion',
    );
  });
}
