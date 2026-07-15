export interface IcpAutonomyRuntimeEnablement {
  isEnabled(): boolean;
  disable(): void;
}

/**
 * One-way live-process fence for operator emergency disable.
 *
 * Enabling remains owned by scheduler.json and requires restart. This runtime
 * primitive can only narrow the effective authority that startup granted.
 */
export function createIcpAutonomyRuntimeEnablement(
  initiallyEnabled: boolean,
): IcpAutonomyRuntimeEnablement {
  let enabled = initiallyEnabled;
  return {
    isEnabled: () => enabled,
    disable: () => {
      enabled = false;
    },
  };
}
