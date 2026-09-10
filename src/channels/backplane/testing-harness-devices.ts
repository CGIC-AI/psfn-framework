import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import { parseBooleanEnv } from '../../shared/utils/env.js';
import { SATELLITE_CLAIM_HEADERS } from './satellite-registry.js';

/**
 * Testing-harness devices (psfn-framework-ajgo2).
 *
 * The harness must be able to drive Satellite Hub surfaces end to end: a
 * Hub-device turn needs the enrolled satellite bearer (a satellite-scoped
 * principal), and a satellite-scoped principal can never be the
 * testing-harness principal, so it could not carry test-run provenance and
 * every such case answered 403. The operator's rule (2026-09-10) is a
 * testing-only registered device, not a looser provenance rule.
 *
 * Two keys, both required, failing closed:
 *   1. `PSFN_TESTING_HARNESS_DEVICES=true` on the process, which is only
 *      accepted when the deployment also configures the testing-harness
 *      principal (`api.testingHarness` in channels.json); and
 *   2. the satellite the turn claims carries `testProvenance` in
 *      satellites.json (a synthetic entry minted by a named harness run and
 *      retired by the synthetic-satellite retirement path).
 *
 * With both, a non-harness principal may attach `x-testing-harness-run-id` /
 * `x-testing-harness-manifest-id` to a turn on that satellite and the turn is
 * stamped exactly like a harness-principal turn (session metadata provenance,
 * so derived memory and the exact purge treat it as harness traffic). With
 * either key missing the existing 403 stands.
 */
export const TESTING_HARNESS_DEVICES_ENV = 'PSFN_TESTING_HARNESS_DEVICES';

export interface TestingHarnessDevicesConfig {
  readonly enabled: true;
}

export function resolveTestingHarnessDevicesConfig(
  testingHarnessPrincipalConfigured: boolean,
  env: NodeJS.ProcessEnv,
): TestingHarnessDevicesConfig | undefined {
  const raw = env[TESTING_HARNESS_DEVICES_ENV];
  const enabled = parseBooleanEnv(raw);
  if (raw?.trim() && enabled === undefined) {
    throw new Error(`${TESTING_HARNESS_DEVICES_ENV} must be a boolean`);
  }
  if (!enabled) return undefined;
  if (!testingHarnessPrincipalConfigured) {
    throw new Error(
      `${TESTING_HARNESS_DEVICES_ENV} requires the testing-harness principal (channels.json api.testingHarness)`,
    );
  }
  return Object.freeze({ enabled: true });
}

/**
 * Whether the satellite a request claims (by its `X-PSFN-Satellite-ID`
 * header) is a testing-harness fixture. This only decides whether the
 * provenance headers may be present; the claim itself is still authenticated
 * by the ordinary satellite admission, and a turn whose claim then fails is
 * refused there.
 */
export function claimedSatelliteIsTestingHarnessDevice(input: {
  config: TestingHarnessDevicesConfig | undefined;
  registry: SatelliteRegistryConfig | undefined;
  satelliteId: string | undefined;
}): boolean {
  if (!input.config?.enabled || !input.registry || !input.satelliteId) return false;
  const satellite = input.registry.satellites.find(candidate => candidate.satelliteId === input.satelliteId);
  return satellite?.testProvenance !== undefined;
}

export function readClaimedSatelliteId(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
  const raw = headers[SATELLITE_CLAIM_HEADERS.satelliteId];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}
