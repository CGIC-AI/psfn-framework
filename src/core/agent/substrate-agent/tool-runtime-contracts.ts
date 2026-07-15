import type { CapabilityToken } from '../../../system/capabilities/tokens.js';
export interface ToolTurnOutcome {
  intent: string | null;
}

export interface PromotedToolMutationResult {
  ok: boolean;
  changed: boolean;
  promotedTools: string[];
  message: string;
  errorCode?:
    | 'invalid_name'
    | 'tool_not_extended'
    | 'duplicate'
    | 'max_slots'
    | 'capability_denied'
    | 'not_found'
    | 'invalid_slot'
    | 'persist_failed';
  requiredTokens?: CapabilityToken[];
  missingTokens?: CapabilityToken[];
}
