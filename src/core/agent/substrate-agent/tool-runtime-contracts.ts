import type { CapabilityToken } from '../../../system/capabilities/tokens.js';
import type { AdaptiveToolSnapshotSkip } from '../adaptive-tools-telemetry.js';

export interface AutoloadTurnOutcome {
  intent: string | null;
  skipped: AdaptiveToolSnapshotSkip[];
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
    | 'background_only'
    | 'capability_denied'
    | 'not_found'
    | 'invalid_slot'
    | 'persist_failed';
  requiredTokens?: CapabilityToken[];
  missingTokens?: CapabilityToken[];
}
