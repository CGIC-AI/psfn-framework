// ── Satellite-endpoint section producer (E2.6) ──
// Renders the satellite endpoint capability block for turns routed through a
// registered satellite endpoint. The message routing metadata is the declared
// input; turns without satellite routing render nothing.

import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import { wrapPromptSectionXml } from '../../../identity/prompt-sections.js';

export function buildSatelliteEndpointContextBlock(message: SubstrateMessage): string {
  const satellite = message.routing?.satellite;
  if (!satellite) return '';

  const effectiveCapabilities = satellite.capabilities.effective.join(', ') || 'none';
  const policyDeniedCapabilities = satellite.capabilities.policyDenied.join(', ') || 'none';
  const telemetryScopes = satellite.telemetryScopes.join(', ') || 'none';
  const locationLine = satellite.staticLocationLabel
    ? `Static location label: ${satellite.staticLocationLabel}`
    : `Mobility: ${satellite.mobility}`;

  return wrapPromptSectionXml({
    id: 'runtime_satellite_endpoint',
    content: [
      '[Satellite endpoint]',
      `Satellite: ${satellite.satelliteDisplayName} (${satellite.satelliteId})`,
      `Endpoint: ${satellite.endpointDisplayName} (${satellite.endpointId}); claim ${satellite.claimType}; session ${satellite.sessionId}`,
      `Prompt channel type: ${satellite.promptChannelType}`,
      locationLine,
      `Effective capabilities: ${effectiveCapabilities}`,
      `Policy-denied or not-yet-modeled capabilities: ${policyDeniedCapabilities}`,
      `Allowed telemetry scopes: ${telemetryScopes}`,
      'Use only the effective capabilities listed here. Do not assume microphone, speech output, camera, avatar, location, or telemetry unless that capability is present.',
      'If audio_input/speech_to_text are present, spoken user input may arrive as text. If audio_output/text_to_speech are present, ordinary replies may be spoken by the satellite.',
    ].join('\n'),
  });
}
