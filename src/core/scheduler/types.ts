import type { EligibilityRequirements } from '../../system/capabilities/eligibility.js';

// ── Scheduler Types ──

export type TaskType = 'every' | 'one-shot';
export type TaskState = 'idle' | 'active' | 'paused' | 'complete';
export type TaskLastOutcome = 'succeeded' | 'failed' | 'denied';
export type RecurringCadenceTimezone = 'local' | 'utc';

export interface RelativeRecurringCadence {
  kind: 'relative';
}

export interface HourlyRecurringCadence {
  kind: 'hourly';
  minute: number;
  timezone: RecurringCadenceTimezone;
}

export interface DailyRecurringCadence {
  kind: 'daily';
  hour: number;
  minute: number;
  timezone: RecurringCadenceTimezone;
}

export interface WeeklyRecurringCadence {
  kind: 'weekly';
  /** Day of week using JavaScript Date numbering: 0=Sunday, 6=Saturday. */
  dayOfWeek: number;
  hour: number;
  minute: number;
  timezone: RecurringCadenceTimezone;
}

export type RecurringCadence =
  | RelativeRecurringCadence
  | HourlyRecurringCadence
  | DailyRecurringCadence
  | WeeklyRecurringCadence;

export interface ScheduledTask {
  id: string;
  name: string;
  type: TaskType;
  /** Interval in milliseconds (for 'every' tasks with relative cadence). */
  intervalMs: number;
  /** Optional cadence for 'every' tasks. Omitted means relative interval cadence. */
  cadence?: RecurringCadence;
  /** Unix timestamp for 'one-shot' tasks */
  runAt?: number;
  /** Handler called when the task fires */
  handler: () => void | Promise<void>;
  /** Optional runtime eligibility requirements evaluated before handler execution. */
  eligibility?: EligibilityRequirements;
  state: TaskState;
  /** Timestamp of the latest actual run attempt, including eligibility-denied attempts. */
  lastRunAt?: number;
  /** Timestamp when the latest run attempt finished or was denied. */
  lastFinishedAt?: number;
  /** Outcome of the latest run attempt. */
  lastOutcome?: TaskLastOutcome;
  /** Error text from the latest failed run attempt. Cleared after success or denial. */
  lastError?: string;
  /** Timestamp for lastError. */
  lastErrorAt?: number;
  /** Eligibility denial code from the latest denied run attempt. Cleared after success or failure. */
  lastDeniedReason?: string;
}

export interface SchedulerConfig {
  /** Base tick interval in ms (default 60s) — how often we check for due tasks */
  tickIntervalMs: number;
  /** Heartbeat interval in ms (default 30min) */
  heartbeatIntervalMs: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  tickIntervalMs: 60_000,
  heartbeatIntervalMs: 30 * 60_000,
};
