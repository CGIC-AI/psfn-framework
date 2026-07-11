export const HOME_ASSISTANT_ALLOWED_DOMAINS = ["light", "fan", "switch", "media_player"] as const;
export const HOME_ASSISTANT_ALLOWED_SERVICES = ["turn_on", "turn_off", "toggle"] as const;

export type HomeAssistantAllowedDomain = typeof HOME_ASSISTANT_ALLOWED_DOMAINS[number];
export type HomeAssistantAllowedService = typeof HOME_ASSISTANT_ALLOWED_SERVICES[number];

export interface HomeAssistantState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export interface HomeAssistantHealth {
  enabled: true;
  status: "connecting" | "ready" | "degraded" | "stopped";
  connected: boolean;
  haVersion?: string;
  stateCount: number;
  connectedAt?: string;
  lastDisconnectedAt?: string;
  lastError?: string;
}

export interface HomeAssistantCallServiceInput {
  requestId: string;
  domain: HomeAssistantAllowedDomain;
  service: HomeAssistantAllowedService;
  entityIds: string[];
  data?: Record<string, unknown>;
}

export interface HomeAssistantCallServiceResult {
  requestId: string;
  domain: HomeAssistantAllowedDomain;
  service: HomeAssistantAllowedService;
  entityIds: string[];
  contextId?: string;
  response: unknown;
}

export class HomeAssistantUnavailableError extends Error {}
export class HomeAssistantRequestError extends Error {}
