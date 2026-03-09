import { ApiError } from '$lib/api/errors';

const DEFAULT_SCHEDULER_LOAD_ERROR_MESSAGE = 'Failed to load scheduler data';

export function shouldUseSchedulerFallback(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function schedulerLoadErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return DEFAULT_SCHEDULER_LOAD_ERROR_MESSAGE;
}
