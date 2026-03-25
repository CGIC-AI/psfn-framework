# PSFN Amica Test Guide

This document covers the `psfn-amica` channel test path.

The design intent is:

- `psfn-live` remains usable without `opanhome`, the Pi client, or the Amica fork.
- `opanhome` hub and Pi client are optional bridge components that are only active when explicitly launched.
- Amica branding, voice, and session wiring must come from deployment config or backend state, not personal hardcoded defaults.
- Required config fails closed. Missing required values should stop the enabled path instead of silently degrading.

## 1. PSFN Core

Add an explicit `psfnAmica` profile in `channels.json` with deployment-owned values:

```json
{
  "psfnAmica": {
    "enabled": true,
    "defaultIdentity": {
      "authorId": "primary-user-id",
      "authorName": "Primary User",
      "canonicalContactId": "contact-primary-user",
      "channelPrivacy": "semi_private"
    }
  }
}
```

Notes:

- `authorId`, `authorName`, and `canonicalContactId` are deployment values.
- Do not commit personal names or live contact IDs as shared defaults.
- If `defaultIdentity` is omitted, callers must provide explicit authenticated PSFN Amica author headers.

## 2. Optional Opanhome Hub

Only configure this if you want the voice bridge path.

Required hub env:

```bash
PSFN_API_BASE_URL=http://127.0.0.1:3100/v1
PSFN_MODEL=psfn
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
```

Notes:

- `ELEVENLABS_VOICE_ID` is deployment-owned.
- The hub should not be started unless those required voice settings are present.
- If you do not run the hub, `psfn-live` still works without it.

## 3. Optional Pi Client

Only configure this if you want a physical satellite.

Required client env for the PSFN Amica path:

```bash
HUB_WS_URL=ws://<hub-host>:8787/
DEVICE_ID=<device-id>
DEVICE_NAME=<display-name>
CONVERSATION_ID=psfn-amica:<site>:<device>
```

Optional local Amica bridge env:

```bash
AMICA_BRIDGE_URL=http://127.0.0.1:3000/api/satelliteBridge/
AMICA_BRIDGE_TOKEN=...
AMICA_BRIDGE_OWNER_MODE=true
```

Notes:

- `CONVERSATION_ID` is the channel identity for the satellite session. Use a deployment-specific value, not a lab default.
- If `AMICA_BRIDGE_URL` is set, `AMICA_BRIDGE_TOKEN` must also be set.
- If the Amica bridge is not configured, the Pi client must continue to function as a plain audio satellite without pretending bridge support exists.

## 4. Amica Fork

Use explicit deployment config when Amica is acting as the `psfn-amica` UI.

Minimum PSFN bridge env:

```bash
NEXT_PUBLIC_CHATBOT_BACKEND=psfn
NEXT_PUBLIC_PSFN_CHANNEL_TYPE=psfn-amica
NEXT_PUBLIC_PSFN_CHANNEL_ID=psfn-amica:<site>:<device>
NEXT_PUBLIC_PSFN_SATELLITE_BRIDGE_ENABLED=true
AMICA_BRIDGE_TOKEN=...
```

Deployment-owned identity config:

```bash
NEXT_PUBLIC_NAME={{char}}
NEXT_PUBLIC_VRM_URL=/vrm/<your-model>.vrm
NEXT_PUBLIC_ELEVENLABS_VOICEID={{elevenlabs_voice_id}}
```

Notes:

- `{{char}}` and `{{elevenlabs_voice_id}}` are deployment-time placeholders. Resolve them from PSFN-owned character settings before starting the app.
- Do not rely on personal fallback values for `NEXT_PUBLIC_NAME` or voice IDs.
- If the PSFN path is enabled, `NEXT_PUBLIC_PSFN_CHANNEL_ID` must be set.
- Voice playback for the bridge path should come from backend-provided audio, not a hardcoded ElevenLabs voice inside the UI.

## 5. Validation

Minimal validation for a clean test:

1. Start `psfn-live`.
2. If using voice, start the optional `opanhome` hub.
3. If using a hardware satellite, start the optional Pi client.
4. Start the Amica fork with the PSFN bridge env.
5. Send a typed message through Amica and verify it lands in `psfn-live` as channel type `psfn-amica`.
6. Speak through the satellite and verify:
   - user text appears in Amica
   - assistant text returns through PSFN
   - assistant audio plays through the bridge path
7. In Garden contacts, delete any stale test `psfn-amica` conversation channels so a reused test session can appear fresh on the next run.

## 6. Current Limitation

Core-managed satellite config pull is still follow-up work. Today, the satellite/hub/Amica path is deployment-configured rather than pulled from PSFN core automatically.
