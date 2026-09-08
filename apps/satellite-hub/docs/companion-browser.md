# Companion browser transport

The Companion PWA keeps its same-origin fleet login and websocket URL. The
gateway forwards browser upgrades to the configured Hub. The Hub authenticates
its configured app endpoint and opens an independently authenticated websocket
back to the gateway. Gateway authorization continues to govern every action.

```
Browser → canonical gateway → Satellite Hub → authenticated gateway → companion
```

Configure the gateway's `FLEET_SSO_COMPANION_UI_HUB_ORIGIN` to the exact internal
HTTP or HTTPS Hub origin. No route or hostname is inferred. Authenticated Hub
upgrades stay on the gateway adapter, so this route does not recurse. Browser
cookies go only to that configured Hub; arbitrary browser headers and authority
claims are rejected or omitted. The gateway's existing HTTP request budget
bounds connection establishment.

On the Hub, set `HUB_COMPANION_UI_CONFIG_PATH` to an external file following
[`config/companion-browser.example.json`](../config/companion-browser.example.json).
Its `canonicalOrigin` is the exact public HTTPS fleet origin. `gatewayOrigin`
is the exact HTTPS origin of the gateway backchannel. The backchannel verifies
TLS; the existing `PSFN_CLIENT_CERT_PATH`, `PSFN_CLIENT_KEY_PATH`, and
`PSFN_CA_CERT_PATH` settings supply a client certificate and CA where required.
The existing `PSFN_API_KEY`, Hub device registry, and device assertion issuer
must also be configured.

`deviceCredentialFiles` contains absolute paths to owner-only secret files.
Each credential must authenticate one active enrollment in the Hub registry.
Exactly one configured endpoint may serve each companion. These are explicitly
enrolled app/display endpoints; browser login never creates a device, selects a
room, or claims primary embodiment. A deployment serving several companions
configures an endpoint for each authorized companion. The browser roster and
gateway fleet session remain the authority for which companions a human may
reach.

The Hub config's `guestMode` defaults in the example to `disabled`. Cookie-free
guest connections require `explicit` in both the Hub config and the gateway's
existing Companion UI guest policy; they never acquire human identity.

The corresponding gateway `satellites.json` endpoint must grant the capability
intersection the app needs. Hub input `text`, `microphone_pcm`, and
`final_transcript` map to gateway `text`, `audio_input`, and `speech_to_text`.
Hub output `streamed_audio` maps to `audio_output` and `text_to_speech`; touch
control maps to `touch`. `status` telemetry supports the app directory;
approvals, artifacts, tool activity, and emotion require their explicit matching
telemetry grants. Missing grants reject, rather than silently broadening access.

The browser sends its existing exact action and PSZA PCM frames. It sends no
device credentials, signed assertion, or channel identity. Renewals occur only
between Hub and gateway, halfway through each signed assertion lifetime. A
fresh assertion is verified against the same connection, companion, device,
enrollment, place, actor, and channel. Its acknowledgment is consumed by the Hub
and never reaches browser state. Revoked enrollment, failed renewal, changed
authority, or an exceeded connection/frame/buffer limit closes the connection.

Only final companion responses emitted by the gateway are synthesized through
the existing Hub TTS adapter. Audio stays within the admitted output capability
and existing audio-init/audio/audio-end brackets. Interrupts stop synthesis and
emit pause-audio; a synthesis failure is a separate system error and leaves the
text reply available. Text-only endpoints invoke no TTS.

Source validation uses real local sockets with synthetic credentials and
provider stubs in `src/channels/api/companion-ui-browser-path.test.ts`. It covers
the complete browser/gateway/Hub round trip, PCM forwarding, signed renewal
past the original expiry, interruption, capability gating, secret exclusion,
and enrollment revocation. Actual mobile microphones, TLS deployment, and live
provider behavior require separate operator configuration and validation.
