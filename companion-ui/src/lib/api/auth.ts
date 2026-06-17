import type { HelloMessage, SatelliteCapabilities } from '../protocol/events.js';

export const PSFN_SATELLITE_MOBILE_CHAT_APP_NAME = 'PSFN Satellite Mobile Chat App';
export const PSFN_SATELLITE_MOBILE_CHAT_APP_DEVICE_ID = 'psfn-satellite-mobile-chat-app';

export interface SatelliteHelloOptions {
  deviceId?: string;
  deviceName?: string;
  sessionId?: string;
  channelId?: string;
  satelliteId?: string;
  satelliteName?: string;
  capabilities?: SatelliteCapabilities;
}

export const MOBILE_CHAT_APP_CAPABILITIES: Required<SatelliteCapabilities> = {
  input: ['text'],
  output: ['text', 'subtitle'],
  control: ['interrupt', 'presence', 'session_attach'],
  safety: ['confirmation_required', 'local_only'],
};

export function buildSatelliteHello(options: SatelliteHelloOptions = {}): HelloMessage {
  const deviceId = normalizeOptional(options.deviceId) ?? PSFN_SATELLITE_MOBILE_CHAT_APP_DEVICE_ID;
  const deviceName = normalizeOptional(options.deviceName) ?? PSFN_SATELLITE_MOBILE_CHAT_APP_NAME;
  const sessionId = normalizeOptional(options.sessionId) ?? PSFN_SATELLITE_MOBILE_CHAT_APP_DEVICE_ID;
  const satelliteId = normalizeOptional(options.satelliteId) ?? deviceId;
  const satelliteName = normalizeOptional(options.satelliteName) ?? deviceName;
  const channelId = normalizeOptional(options.channelId);

  const hello: HelloMessage = {
    type: 'hello',
    deviceId,
    deviceName,
    sessionId,
    satelliteId,
    satelliteName,
    capabilities: mergeCapabilities(MOBILE_CHAT_APP_CAPABILITIES, options.capabilities),
  };

  if (channelId) {
    hello.channelId = channelId;
  }

  return hello;
}

function mergeCapabilities(
  defaults: Required<SatelliteCapabilities>,
  overrides?: SatelliteCapabilities,
): Required<SatelliteCapabilities> {
  return {
    input: mergeCapabilityList(defaults.input, overrides?.input),
    output: mergeCapabilityList(defaults.output, overrides?.output),
    control: mergeCapabilityList(defaults.control, overrides?.control),
    safety: mergeCapabilityList(defaults.safety, overrides?.safety),
  };
}

function mergeCapabilityList<T extends string>(defaults: readonly T[], overrides?: readonly T[]): T[] {
  return [...new Set([...defaults, ...(overrides ?? [])])];
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
