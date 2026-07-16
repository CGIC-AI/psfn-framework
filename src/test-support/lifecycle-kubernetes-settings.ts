import type {
  LifecycleKubernetesSettings,
} from '../system/config/runtime-config-contracts.js';

export function lifecycleKubernetesSettingsFixture(
  overrides: Partial<LifecycleKubernetesSettings> = {},
): LifecycleKubernetesSettings {
  return {
    lifecycleCommandTimeoutMs: 30_000,
    operatorCommandTimeoutMs: 600_000,
    operatorHttpTimeoutMs: 8_000,
    operatorConfirmationRequestTimeoutMs: 5_000,
    kubernetesReadRequestTimeoutMs: 5_000,
    kubernetesRolloutRequestTimeoutMs: 5_000,
    rolloutWaitTimeoutMs: 180_000,
    rolloutPollIntervalMs: 3_000,
    rollbackWaitTimeoutMs: 180_000,
    rollbackPollIntervalMs: 3_000,
    postRolloutMaxLogRecords: 10,
    postRolloutValidationHistoryLimit: 20,
    rollbackHistoryLimit: 50,
    ...overrides,
  };
}
