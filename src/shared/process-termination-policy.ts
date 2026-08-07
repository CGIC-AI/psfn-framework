/**
 * Grace period after SIGTERM before command runners force termination.
 *
 * This is one process-lifecycle invariant shared by every bounded repository
 * command runner, rather than operator tuning that may differ per command.
 */
export const PROCESS_TERMINATION_GRACE_TIMEOUT_MS = 250;
