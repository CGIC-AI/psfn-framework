import type { AutomataOwnerPolicy } from '../../faculties/automata/registry-contract.js';
import type { CanonicalModelRegistry } from '../../shared/contracts/runtime.js';
import { listEnabledModelRegistrySlotKeys } from './model-selection-config.js';

export const AUTOMATA_FILE_NAME = 'automata-policy.json';

/** Validate owner references before startup or either side of a cross-file edit. */
export function assertAutomataReviewerModelResolvable(
  policy: AutomataOwnerPolicy,
  modelRegistry: CanonicalModelRegistry,
): void {
  if (!policy.bus.reviewer.enabled) return;
  const slots = listEnabledModelRegistrySlotKeys({ modelRegistry });
  if (!slots.includes(policy.bus.reviewer.model)) {
    throw new Error(
      `${AUTOMATA_FILE_NAME}.bus.reviewer.model references slot "${policy.bus.reviewer.model}", `
      + 'which is not an enabled models.json registry entry. '
      + `Select an enabled slot (${slots.join(', ') || 'none'}) or disable the reviewer.`,
    );
  }
}
