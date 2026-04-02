import type { EventBus } from '../event-bus.js';
import { getRequestContext } from '../llm/request-context.js';

export interface LegacyAliasTelemetryPayload {
  toolName: string;
  alias: string;
  canonicalAction: string;
  migrationSurface: string;
}

export type LegacyAliasTelemetryCallback = (payload: LegacyAliasTelemetryPayload) => void;

export function createLegacyAliasTelemetryEmitter(
  eventBus: Pick<EventBus, 'emit'> | null | undefined,
): LegacyAliasTelemetryCallback | undefined {
  if (!eventBus) return undefined;
  return (payload) => {
    const requestContext = getRequestContext();
    void eventBus.emit('agent.tools.legacy_alias', {
      timestamp: Date.now(),
      toolName: payload.toolName,
      alias: payload.alias,
      canonicalAction: payload.canonicalAction,
      migrationSurface: payload.migrationSurface,
      callType: requestContext?.callType ?? 'tool',
      purpose: requestContext?.purpose ?? 'agent.tools.legacy_alias',
      originType: requestContext?.originType ?? 'tool',
      originStage: requestContext?.originStage ?? 'agent.tools.legacy_alias',
      ...(requestContext?.turnId ? { turnId: requestContext.turnId } : {}),
      ...(requestContext?.requestId ? { requestId: requestContext.requestId } : {}),
      ...(requestContext?.channelId ? { channelId: requestContext.channelId } : {}),
      ...(requestContext?.toolName ? { toolName: requestContext.toolName } : {}),
      ...(requestContext?.toolCallId ? { toolCallId: requestContext.toolCallId } : {}),
    });
  };
}
