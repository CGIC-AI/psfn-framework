import type { SubstrateConfig } from '../system/config/runtime-config-contracts.js';
import { resolveConfiguredCompanionDataDir } from '../persistence/layout.js';
import { InternalRoleEnvelopeLedgerStore } from './store.js';
import type { InternalRoleEnvelopeLedger } from './types.js';

export interface InternalRoleEnvelopeRuntimeTarget {
  setInternalRoleEnvelopeLedger(ledger: InternalRoleEnvelopeLedger | null): void;
}

export function wireInternalRoleEnvelopeRuntime(
  target: InternalRoleEnvelopeRuntimeTarget,
  config: SubstrateConfig,
): InternalRoleEnvelopeLedgerStore {
  const store = new InternalRoleEnvelopeLedgerStore(resolveConfiguredCompanionDataDir(config));
  target.setInternalRoleEnvelopeLedger(store);
  return store;
}
