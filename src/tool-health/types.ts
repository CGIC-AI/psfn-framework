export type RuntimeServiceHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'not_applicable';

export type RuntimeServiceId = 'gateway' | 'vault' | 'ntfy';

export interface RuntimeServiceFailure {
  message: string;
  at: number;
  scope?: string;
}

export interface RuntimeServiceHealth {
  serviceId: RuntimeServiceId;
  status: RuntimeServiceHealthStatus;
  detail: string;
  checkedAt: number;
  availableActions?: string[];
  lastFailure?: RuntimeServiceFailure;
}

export interface RuntimeServiceHealthSnapshot {
  checkedAt: number;
  services: RuntimeServiceHealth[];
}
