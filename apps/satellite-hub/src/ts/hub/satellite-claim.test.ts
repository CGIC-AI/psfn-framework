import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSatelliteRegistryHeaders,
  buildSatelliteClaimEnvelope,
  frameworkCapabilitiesForSatelliteCapabilities,
  frameworkTelemetryScopesForConfig,
  normalizeSatelliteClaimConfig,
} from "./satellite-claim.js";

test("satellite claim config supports mobile location endpoint profiles", () => {
  const config = normalizeSatelliteClaimConfig({
    capabilityProfile: "mobile-location",
    satelliteId: "phone-sat",
    endpointId: "phone-browser",
    displayName: "Phone Browser",
  });

  assert.equal(config.namespace, "satellite.endpoint");
  assert.equal(config.channelType, "satellite.endpoint");
  assert.equal(config.endpointClass, "mobile");
  assert.equal(config.locationMode, "mobile");
  assert.deepEqual(config.telemetry, {
    mode: "event",
    categories: ["location", "timezone", "presence", "battery", "health"],
  });
  assert.deepEqual(frameworkCapabilitiesForSatelliteCapabilities(
    {
      input: ["microphone_pcm", "final_transcript", "text", "vision_upload", "wake_event"],
      output: ["text", "subtitle", "streamed_audio"],
      control: ["interrupt", "presence", "session_attach"],
      safety: ["confirmation_required"],
    },
  ), [
    "text",
    "audio_input",
    "speech_to_text",
    "audio_output",
    "text_to_speech",
    "vision",
    "image_upload",
  ]);
  assert.deepEqual(frameworkTelemetryScopesForConfig(config.telemetry), [
    "location",
    "timezone",
    "presence",
    "battery",
    "health",
  ]);
});

test("satellite claim envelope carries current capabilities without granting permissions", () => {
  const config = normalizeSatelliteClaimConfig({
    capabilityProfile: "voxta-avatar",
    satelliteId: "voxta-vam",
    endpointId: "vam-plugin",
    displayName: "Voxta VaM",
  });
  const envelope = buildSatelliteClaimEnvelope({
    config,
    conversationId: "voxta:chat-1",
    apiKey: "secret",
    channel: {
      sessionId: "voxta:chat-1",
      channelType: "satellite.endpoint",
      channelId: "satellite.endpoint:voxta:chat-1",
      sourceSatelliteId: "voxta-vam",
      sourceSatelliteName: "Voxta VaM",
      activeSatellites: [
        {
          id: "voxta-vam",
          name: "Voxta VaM",
          transport: "websocket",
          capabilities: {
            input: ["text"],
            output: ["text", "subtitle"],
            control: ["interrupt", "presence"],
            safety: ["action_allowlist"],
          },
        },
      ],
    },
  });

  assert.equal(envelope.claim.namespace, "satellite.endpoint");
  assert.equal(envelope.claim.type, "voxta-avatar");
  assert.equal(envelope.claim.deviceClass, "avatar");
  assert.deepEqual(envelope.capabilities.current, {
    input: ["text"],
    output: ["text", "subtitle"],
    control: ["interrupt", "presence"],
    safety: ["action_allowlist"],
  });
  assert.deepEqual(envelope.auth, {
    mode: "bearer",
    clientCertificateConfigured: false,
  });
  assert.deepEqual(buildSatelliteRegistryHeaders({ config, satelliteClaim: envelope }), {
    "X-PSFN-Satellite-Claim-Type": "voxta-avatar",
    "X-PSFN-Satellite-ID": "voxta-vam",
    "X-PSFN-Satellite-Endpoint-ID": "vam-plugin",
    "X-PSFN-Satellite-Session-ID": "voxta:chat-1",
    "X-PSFN-Satellite-Thread-ID": "voxta:chat-1",
    "X-PSFN-Satellite-Capabilities": "text",
    "X-PSFN-Satellite-Telemetry-Scopes": "presence,status",
  });
});

test("authenticated channel identity overrides client-independent hub claim headers", () => {
  const config = normalizeSatelliteClaimConfig({
    capabilityProfile: "text-only",
    satelliteId: "hub-default",
    endpointId: "hub-default",
  });
  const envelope = buildSatelliteClaimEnvelope({
    config,
    conversationId: "room:office",
    channel: {
      sessionId: "room:office",
      channelType: "satellite.endpoint",
      channelId: "satellite.endpoint:room:office",
      sourceSatelliteId: "office",
      sourceSatelliteName: "Office",
      claimIdentity: {
        satelliteId: "office",
        endpointId: "office-device",
        claimType: "room-satellite",
        displayName: "Office",
      },
      activeSatellites: [{
        id: "office", name: "Office", transport: "websocket",
        capabilities: { input: ["text"], output: ["text"], control: [], safety: ["local_only"] },
      }],
    },
  });
  assert.deepEqual(buildSatelliteRegistryHeaders({ config, satelliteClaim: envelope }), {
    "X-PSFN-Satellite-Claim-Type": "room-satellite",
    "X-PSFN-Satellite-ID": "office",
    "X-PSFN-Satellite-Endpoint-ID": "office-device",
    "X-PSFN-Satellite-Session-ID": "room:office",
    "X-PSFN-Satellite-Thread-ID": "room:office",
    "X-PSFN-Satellite-Capabilities": "text",
  });
});
