import { ShardDirectoryOperationalError } from '../../shared/contracts/shard-directory.js';

export interface CompanionUiShardActionFailure {
  readonly status: 403 | 503;
  readonly type:
    | 'companion_ui_shard_action_denied'
    | 'companion_ui_shard_action_unavailable';
  readonly message: string;
  readonly logMessage: string;
  readonly logError: unknown;
}

export function classifyCompanionUiShardActionFailure(
  error: unknown,
): CompanionUiShardActionFailure {
  if (error instanceof ShardDirectoryOperationalError) {
    return {
      status: 503,
      type: 'companion_ui_shard_action_unavailable',
      message: 'Companion UI shard action is temporarily unavailable',
      logMessage: 'Companion UI shard action failed operationally',
      logError: error.cause,
    };
  }
  return {
    status: 403,
    type: 'companion_ui_shard_action_denied',
    message: 'Companion UI shard action was denied',
    logMessage: 'Companion UI shard action denied',
    logError: error,
  };
}
