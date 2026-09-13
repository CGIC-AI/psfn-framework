/** Content-free evidence for one authenticated companion's system monitor. */
export interface SocialOutreachHealthSummary {
  total: number;
  states: Array<{ state: string; count: number; lastUpdatedAtMs: number }>;
  lastFiredAtMs: number | null;
  lastDeliveredAtMs: number | null;
}

export interface CompanionSystemMonitorEvidence {
  companionId: string;
  freeTimeEnabled: boolean;
  socialDesireEnabled: boolean;
  weightedThoughtOutreachEnabled: boolean;
  emosimProactivityMode: 'off' | 'shadow' | 'on';
  proactive: { status: 'available'; summary: SocialOutreachHealthSummary }
    | { status: 'unavailable' | 'error' };
}
