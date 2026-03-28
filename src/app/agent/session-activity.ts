import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { inferSessionChannelType } from '../../core/session/session-id.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { SessionRestartBehavior } from '../../system/config/runtime-config-contracts.js';
import { writeLastActiveSession } from '../../system/lifecycle/notifications.js';

const log = createComponentLogger('Agent');

export function writeStartupSessionMetadata(
  sessionManager: SessionManager,
  companionDataDir: string,
  restartBehavior: SessionRestartBehavior = 'reuse_latest_session',
): void {
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
  };
}
