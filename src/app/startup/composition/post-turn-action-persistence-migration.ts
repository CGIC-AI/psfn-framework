import type { InferredPostTurnAction } from '../../../shared/contracts/runtime.js';
import { isRecord } from '../../../shared/utils/types.js';
import { normalizeIntentionOutboundMessageActionPayload } from '../../../core/intention/appraisal/action-translation.js';
import { INTENTION_OUTBOUND_MESSAGE_ACTION_KIND } from '../../../core/intention/appraisal/types.js';

export const PERSISTED_POST_TURN_ACTION_PAYLOAD_VERSION = 2;

export interface PersistedPostTurnActionPayloadNormalization {
  action: InferredPostTurnAction;
  migrated: boolean;
  requiresRewrite: boolean;
}

function isLegacyPersonalProjectPayloadKey(key: string): boolean {
  return key === 'channelId'
    || key === 'channelType'
    || key === 'content'
    || key === 'reason'
    || key === 'originIcpRootInitiationId'
    || key === 'personalProjectId'
    || key === 'pendingFollowUpId'
    || key === 'concernIds';
}

function migrateLegacyPersonalProjectAction(
  action: InferredPostTurnAction,
): InferredPostTurnAction | null {
  if (action.kind !== INTENTION_OUTBOUND_MESSAGE_ACTION_KIND) {
    return null;
  }
  const payload = action.payload;
  if (!Object.keys(payload).every(isLegacyPersonalProjectPayloadKey)) {
    return null;
  }
  const personalProjectId = typeof payload.personalProjectId === 'string'
    ? payload.personalProjectId.trim()
    : '';
  if (!personalProjectId) {
    return null;
  }

  const hasPendingFollowUpId = typeof payload.pendingFollowUpId === 'string'
    && payload.pendingFollowUpId.trim().length > 0;
  if (Object.hasOwn(payload, 'pendingFollowUpId') && !hasPendingFollowUpId) {
    return null;
  }
  const hasConcernIds = Array.isArray(payload.concernIds)
    && payload.concernIds.length > 0
    && payload.concernIds.every(id => typeof id === 'string' && id.trim().length > 0);
  if (Object.hasOwn(payload, 'concernIds') && !hasConcernIds) {
    return null;
  }
  if (!hasPendingFollowUpId && !hasConcernIds) {
    return null;
  }

  const {
    pendingFollowUpId: _legacyPendingFollowUpId,
    concernIds: _legacyConcernIds,
    ...projectPayload
  } = payload;
  const normalizedPayload = normalizeIntentionOutboundMessageActionPayload(projectPayload);
  if (
    !normalizedPayload
    || normalizedPayload.personalProjectId !== personalProjectId
    || !isRecord(normalizedPayload)
  ) {
    return null;
  }
  return {
    ...action,
    payload: normalizedPayload,
  };
}

export function normalizePersistedPostTurnActionPayload(input: {
  action: InferredPostTurnAction;
  actionPayloadVersion: unknown;
  hasActionPayloadVersion: boolean;
}): PersistedPostTurnActionPayloadNormalization | null {
  if (input.hasActionPayloadVersion) {
    if (input.actionPayloadVersion !== PERSISTED_POST_TURN_ACTION_PAYLOAD_VERSION) {
      return null;
    }
    return {
      action: input.action,
      migrated: false,
      requiresRewrite: false,
    };
  }

  const migratedAction = migrateLegacyPersonalProjectAction(input.action);
  return {
    action: migratedAction ?? input.action,
    migrated: migratedAction !== null,
    requiresRewrite: true,
  };
}
