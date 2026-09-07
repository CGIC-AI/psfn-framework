import type { HelloMessage, SatelliteCapabilities } from '../protocol/events.js';
import { COMPANION_APPROVALS_V2_CAPABILITY } from '../../../../src/shared/contracts/companion-relay.js';

export const PSFN_SATELLITE_MOBILE_CHAT_APP_NAME = 'PSFN Companion UI';

export interface SatelliteHelloOptions {
  capabilities?: SatelliteCapabilities;
}

/**
 * Presentation defaults only. `microphone_pcm` is deliberately absent: browser
 * audio input is negotiated server-side, never self-declared here. The gateway
 * derives microphone eligibility from the enrolled device's registered physical
 * ceiling (`audio_input` plus `speech_to_text` in
 * `src/channels/api/companion-ui-websocket.ts`) and advertises that filtered
 * ceiling in `session.ready`; the client maps `audio_input` to `microphone_pcm`
 * (`mapCapabilities` in gateway-protocol.ts) and gates capture on
 * `session.capabilities.input.includes('microphone_pcm')` (gateway-client.ts,
 * App.tsx). A browser-declared claim would grant no capture and only invite a
 * ceiling the device has not been enrolled for.
 */
export const MOBILE_CHAT_APP_CAPABILITIES: Required<SatelliteCapabilities> = {
  input: ['text', 'device_location'],
  output: ['text', 'subtitle', 'artifact', 'tool_activity'],
  control: ['interrupt', 'presence', 'session_attach', 'approvals', 'touch'],
  safety: ['confirmation_required', 'local_only'],
};

/**
 * The browser advertises presentation capabilities only. Device, place,
 * enrollment, session, channel, companion, and credential authority is
 * supplied by the authenticated Hub attachment and never appears here.
 */
export function buildSatelliteHello(options: SatelliteHelloOptions = {}): HelloMessage {
  return Object.freeze({
    type: 'hello',
    capabilities: mergeCapabilities(MOBILE_CHAT_APP_CAPABILITIES, options.capabilities),
    eventCapabilities: [COMPANION_APPROVALS_V2_CAPABILITY],
  });
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
