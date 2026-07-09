// ── Multi-companion e2e helpers ──
// Pure, side-effect-free helpers for the flag-gated multi-companion section of
// the e2e harness (`e2e-test.ts`). Kept in their own module so they can be
// unit-tested without booting the full runtime. The section itself (fleet
// resolution + Postgres schema provisioning) lives in `e2e-test.ts`; only the
// deterministic summarization logic lives here.

import type { CompanionsFleetConfig } from '../../system/config/companions-config.js';

export interface CompanionFleetE2ESummary {
  /** Number of companions enumerated by the fleet manifest. */
  companionCount: number;
  /** Each companion's Postgres tenant schema, in manifest order. */
  schemas: string[];
  /** Each companion's UUID, in manifest order. */
  companionIds: string[];
  /** Declared Garden operator ports (companions without a gardenPort omitted). */
  gardenPorts: number[];
}

/**
 * Reduce a resolved fleet to the fields the e2e section asserts on. Pure: no
 * clock, I/O, or global state — safe to unit-test directly.
 */
export function summarizeCompanionFleet(fleet: CompanionsFleetConfig): CompanionFleetE2ESummary {
  const companions = fleet.companions;
  return {
    companionCount: companions.length,
    schemas: companions.map((entry) => entry.postgresSchema),
    companionIds: companions.map((entry) => entry.companionId),
    gardenPorts: companions.flatMap((entry) =>
      entry.gardenPort === undefined ? [] : [entry.gardenPort],
    ),
  };
}

/**
 * True when every companion in the summary has a distinct Postgres schema — the
 * tenancy invariant that keeps two companions on one database from colliding.
 */
export function hasUniqueSchemas(summary: CompanionFleetE2ESummary): boolean {
  return new Set(summary.schemas).size === summary.schemas.length;
}
