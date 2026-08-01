import type { CapabilityDeniedTransportPolicy } from '../../system/capabilities/gate.js';
import { SHARD_MASK_TEMPORARY_GRANT_DISPOSITIONS } from '../../system/capabilities/shard-derivation.js';
import { isRecord } from '../../shared/utils/types.js';

/**
 * Agent-side transport permit for the one approved masked exceptional action.
 * It deliberately leaves the derived access unchanged: the gateway must still
 * bind the request to a live workload and obtain one exact operator approval.
 */
export const allowShardRequestScopedCapabilityTransport: CapabilityDeniedTransportPolicy = (
  input,
) => (input.toolName === 'world'
  && isRecord(input.params)
  && input.params.action === 'control'
  && input.requiredTokens.length === 1
  && input.requiredTokens[0] === 'world.control'
  && input.missingTokens.length === 1
  && input.missingTokens[0] === 'world.control'
  && SHARD_MASK_TEMPORARY_GRANT_DISPOSITIONS['world.control'].requestScoped
    === 'human-approval-required')
  || (input.toolName === 'beads'
    && isRecord(input.params)
    && (input.params.action === 'close' || input.params.action === 'issue_close')
    && input.requiredTokens.length === 1
    && input.requiredTokens[0] === 'issue.close'
    && input.missingTokens.length === 1
    && input.missingTokens[0] === 'issue.close');
