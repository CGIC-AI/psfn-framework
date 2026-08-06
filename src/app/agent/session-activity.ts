import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { inferSessionChannelType } from '../../core/session/session-id.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { SessionRestartBehavior } from '../../system/config/runtime-config-contracts.js';
import {
  readLastActiveSession,
  writeLastActiveSession,
} from '../../system/lifecycle/notifications.js';
import {
  CAPABILITY_TIER_CHANGE_NOTICE_AUTHOR_ID,
  deliverPendingCapabilityTierChangeNotices,
} from '../../system/capabilities/change-notice.js';

const log = createComponentLogger('Agent');

export function writeStartupSessionMetadata(
  sessionManager: SessionManager,
  companionDataDir: string,
  restartBehavior: SessionRestartBehavior = 'reuse_latest_session',
): void {
  if (restartBehavior !== 'new_session') {
    const persisted = readLastActiveSession(companionDataDir);
    if (persisted && sessionManager.getMessageCount(persisted.sessionId) > 0) {
      writeLastActiveSession(companionDataDir, persisted);
      log.info('Restored persisted startup session metadata', {
        sessionId: persisted.sessionId,
        channelType: persisted.channelType ?? 'unknown',
        timestamp: persisted.timestamp,
      });
      return;
    }
  }

  const startupSession = sessionManager.resolveStartupSessionMetadata(restartBehavior);
  if (!startupSession) {
    return;
  }

  writeLastActiveSession(companionDataDir, startupSession);
  if (restartBehavior === 'new_session') {
    log.info('Initialized fresh startup session metadata', {
      sessionId: startupSession.sessionId,
      channelType: startupSession.channelType ?? 'unknown',
      timestamp: startupSession.timestamp,
    });
    return;
  }

  log.info('Restored latest session metadata', {
    sessionId: startupSession.sessionId,
    channelType: startupSession.channelType ?? 'unknown',
    timestamp: startupSession.timestamp,
  });
}

export function createSessionActivityTracker(
  sessionManager: SessionManager,
  companionDataDir: string,
): (message: SubstrateMessage) => void {
  return (message: SubstrateMessage): void => {
    const sessionId = sessionManager.resolveSessionChannelId(message.channelId);
    writeLastActiveSession(companionDataDir, {
      sessionId,
      channelId: message.channelId,
      channelType: inferSessionChannelType(sessionId) ?? message.channelType,
      timestamp: message.timestamp instanceof Date
        ? message.timestamp.getTime()
        : Date.now(),
    });
    const deliveredNoticeCount = deliverPendingCapabilityTierChangeNotices(
      companionDataDir,
      (notice) => {
        const entryId = sessionManager.recordSystemMessage(
          sessionId,
          notice,
          CAPABILITY_TIER_CHANGE_NOTICE_AUTHOR_ID,
          'Capability policy',
        );
        if (entryId === null) {
          throw new Error(
            `session "${sessionId}" cannot persist a pending companion capability-tier notice`,
          );
        }
      },
    );
    if (deliveredNoticeCount > 0) {
      log.info('Delivered pending capability-tier notices into active conversation', {
        sessionId,
        deliveredNoticeCount,
      });
    }
  };
}
