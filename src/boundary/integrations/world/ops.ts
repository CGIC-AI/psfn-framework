import type {
  HomeAssistantCallServiceResult,
  HomeAssistantGetStatesResult,
} from '../../gateway/protocol.js';

// ── Agent-side world operations port (Sprint 10, Workstream C2) ──
//
// `WorldOperations` is the thin agent-side port the `world` tool calls. It
// forwards to the privileged gateway Home Assistant methods (bead .8) which
// hold the token and own the SSRF lane. The agent process never sees the HA
// token; it only ever asks the gateway to read validated states or call a
// validated service on an already-resolved `entity_id`.
//
// Affordance → entity resolution happens ABOVE this port (in `tools.ts`,
// against `places.json`), so the gateway only ever receives a concrete
// `entity_id`/`service` that the agent proved is in the registry. This port is
// intentionally backend-shaped (HA) rather than affordance-shaped.

export interface WorldGetStatesParams {
  /** Optional single HA entity_id to fetch; omit to fetch all states. */
  entityId?: string;
}

export interface WorldCallServiceParams {
  domain: string;
  service: string;
  entityId?: string;
  entityIds?: string[];
  data?: Record<string, unknown>;
}

export interface WorldOperations {
  getStates(params?: WorldGetStatesParams): Promise<HomeAssistantGetStatesResult>;
  callService(params: WorldCallServiceParams): Promise<HomeAssistantCallServiceResult>;
}
