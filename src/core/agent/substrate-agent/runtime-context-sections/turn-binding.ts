// ── Turn-binding section producer (E2.6) ──
// The internal-turn kind, the one-on-one speaking_with binding, and the
// channel type/visibility variables for one turn.

import type { ChannelVisibility, TrustLevel } from '../../../../system/trust/types.js';

export function buildTurnBindingPromptVariables(input: {
  internalTurn: boolean;
  taskKind?: string;
  speakingWithActive: boolean;
  resolvedUserName: string;
  trustLevel: TrustLevel;
  channelType: string | undefined;
  visibility: ChannelVisibility;
}): Record<string, string> {
  return {
    runtime_internal_turn_kind: input.internalTurn ? (input.taskKind ?? 'background') : '',
    // E1.3: speaking_with context populates ONLY on genuine DM turns. On group
    // turns (and internal turns) speakingWithActive is false, so these tokens
    // are blank and any prompt layer that still references them prunes cleanly
    // instead of binding a multi-human room to the most-recent speaker.
    runtime_speaking_with_name: input.speakingWithActive ? input.resolvedUserName : '',
    runtime_speaking_with_trust_level: input.speakingWithActive ? input.trustLevel : '',
    runtime_channel_type: input.internalTurn ? '' : (input.channelType ?? 'unknown'),
    runtime_channel_visibility: input.internalTurn ? '' : input.visibility,
  };
}
