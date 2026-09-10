import { describe, expect, it } from 'vitest';

import { parseSatelliteRegistryConfig } from './satellite-registry.js';
import {
  claimedSatelliteIsTestingHarnessDevice,
  readClaimedSatelliteId,
  resolveTestingHarnessDevicesConfig,
  TESTING_HARNESS_DEVICES_ENV,
} from './testing-harness-devices.js';

const REGISTRY = parseSatelliteRegistryConfig({
  schemaVersion: 1,
  enabled: true,
  satellites: [
    {
      satelliteId: 'physical-satellite',
      displayName: 'Physical fixture',
      mobility: 'static',
      placeId: 'office',
      testProvenance: {
        schemaVersion: 1,
        kind: 'testing_harness',
        runId: '47023c9c-2a7e-4dad-b950-a8fe74608eee',
        manifestId: 'shakedown:fixture:47023c9c-2a7e-4dad-b950-a8fe74608eee',
      },
      endpoints: [{
        endpointId: 'physical-endpoint',
        displayName: 'Physical endpoint',
        claimTypes: ['satellite-endpoint'],
        promptChannelType: 'satellite-endpoint',
        auth: { mode: 'api_key' },
        defaultIdentity: {
          authorId: 'fixture', authorName: 'Fixture', canonicalContactId: 'contact-fixture', channelPrivacy: 'private',
        },
        maxCapabilities: ['text'],
        telemetryScopes: ['presence'],
      }],
    },
    {
      satelliteId: 'bedroom',
      displayName: 'Bedroom (real)',
      mobility: 'static',
      placeId: 'bedroom',
      endpoints: [{
        endpointId: 'bedroom-pi',
        displayName: 'Bedroom Pi',
        claimTypes: ['satellite-endpoint'],
        promptChannelType: 'satellite-endpoint',
        auth: { mode: 'api_key' },
        defaultIdentity: {
          authorId: 'partner', authorName: 'Partner', canonicalContactId: 'contact-partner', channelPrivacy: 'private',
        },
        maxCapabilities: ['text'],
        telemetryScopes: ['presence'],
      }],
    },
  ],
});

describe('testing-harness devices (psfn-framework-ajgo2)', () => {
  it('needs both keys: the env flag and the configured harness principal', () => {
    expect(resolveTestingHarnessDevicesConfig(true, {})).toBeUndefined();
    expect(resolveTestingHarnessDevicesConfig(true, { [TESTING_HARNESS_DEVICES_ENV]: 'false' })).toBeUndefined();
    expect(resolveTestingHarnessDevicesConfig(true, { [TESTING_HARNESS_DEVICES_ENV]: 'true' })).toEqual({ enabled: true });
    expect(() => resolveTestingHarnessDevicesConfig(false, { [TESTING_HARNESS_DEVICES_ENV]: 'true' }))
      .toThrow(/requires the testing-harness principal/);
    expect(() => resolveTestingHarnessDevicesConfig(true, { [TESTING_HARNESS_DEVICES_ENV]: 'sometimes' }))
      .toThrow(/must be a boolean/);
  });

  it('admits provenance only on a testProvenance satellite while the flag is on', () => {
    const enabled = { enabled: true as const };
    expect(claimedSatelliteIsTestingHarnessDevice({ config: enabled, registry: REGISTRY, satelliteId: 'physical-satellite' })).toBe(true);
    expect(claimedSatelliteIsTestingHarnessDevice({ config: enabled, registry: REGISTRY, satelliteId: 'bedroom' })).toBe(false);
    expect(claimedSatelliteIsTestingHarnessDevice({ config: enabled, registry: REGISTRY, satelliteId: 'unknown' })).toBe(false);
    expect(claimedSatelliteIsTestingHarnessDevice({ config: enabled, registry: REGISTRY, satelliteId: undefined })).toBe(false);
    expect(claimedSatelliteIsTestingHarnessDevice({ config: undefined, registry: REGISTRY, satelliteId: 'physical-satellite' })).toBe(false);
    expect(claimedSatelliteIsTestingHarnessDevice({ config: enabled, registry: undefined, satelliteId: 'physical-satellite' })).toBe(false);
  });

  it('reads the claimed satellite id from the canonical header only', () => {
    expect(readClaimedSatelliteId({ 'x-psfn-satellite-id': ' physical-satellite ' })).toBe('physical-satellite');
    expect(readClaimedSatelliteId({ 'x-psfn-satellite-id': ['a', 'b'] })).toBe('a');
    expect(readClaimedSatelliteId({ 'x-psfn-satellite-id': '' })).toBeUndefined();
    expect(readClaimedSatelliteId({})).toBeUndefined();
    expect(readClaimedSatelliteId({ 'x-psfn-satellite-id': 'x'.repeat(257) })).toBeUndefined();
  });
});
