// ── Core-owned API health snapshot contracts (psfn-framework-kbdvl.1) ──

export const API_HEALTH_SUBSYSTEMS = [
  'memory',
  'llm',
  'discord',
  'embeddings',
  'scheduler',
] as const;

export const API_CONTINUITY_WATCHDOG_CHECKS = [
  'database',
  'gatewayLink',
  'schedulerHealthcheck',
] as const;

export type ApiHealthState = 'healthy' | 'degraded';
export type ApiHealthSubsystem = (typeof API_HEALTH_SUBSYSTEMS)[number];
export type ApiContinuityWatchdogCheck = (typeof API_CONTINUITY_WATCHDOG_CHECKS)[number];

export interface ApiHealthSubsystemStatus {
  status: ApiHealthState;
  detail?: string;
  meta?: Record<string, unknown>;
}

export interface ApiHealthResponse {
  status: ApiHealthState;
  checkedAt: string;
  uptimeSeconds: number;
  subsystems: Record<ApiHealthSubsystem, ApiHealthSubsystemStatus>;
  continuity: {
    status: ApiHealthState;
    checks: Record<ApiContinuityWatchdogCheck, ApiHealthSubsystemStatus>;
  };
}
