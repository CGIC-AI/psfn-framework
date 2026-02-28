# Discord DM + Voice Readiness

*Revision date: 2026-02-28*

This document defines the deployment contract for Discord DM routing plus Discord voice receive/transmit readiness.

## Opus dependency strategy

PSFN uses `prism-media` for Discord voice decode. `prism-media` requires an Opus backend.

Strategy:

1. Prefer `@discordjs/opus` (native; best performance and lower CPU overhead).
2. Allow `opusscript` as fallback (portable JS; higher CPU cost).
3. Declare both as `optionalDependencies` in `package.json` so install/build failures on one backend do not block deployment.
4. Enforce at runtime with `voicePreflight()` / `checkOpusAvailability()` in `src/channels/discord/voice.ts`:
   - If no Opus backend is usable, voice runtime is disabled safely.
   - Discord DM/text handling still runs.

## Required config by capability

| Capability | Required keys | Notes |
| --- | --- | --- |
| Discord DM routing | `DISCORD_TOKEN`, `DISCORD_BOT_ID` | DMs are always routed; guild messages still require mention. |
| Discord voice runtime gate | `VOICE_ENABLED=true`, `VOICE_TARGET_GUILD_ID`, `VOICE_TARGET_USER_ID`, `DEEPGRAM_API_KEY` | Missing any key keeps voice runtime disabled intentionally. |
| TTS provider (`elevenlabs`) | `ELEVENLABS_API_KEY` | `ELEVENLABS_VOICE_ID` is optional; runtime default voice ID is used when omitted. |
| TTS provider (`echo`) | `ECHO_TTS_URL`, `ECHO_TTS_VOICE` | Required if Echo is selected and no ElevenLabs fallback is configured. |
| Opus backend | `@discordjs/opus` preferred, `opusscript` fallback | At least one working backend must be present for voice receive. |

## Smoke harness

Script: `scripts/discord-dm-voice-smoke.mjs`

Package command:

```bash
npm run smoke:discord:dm-voice
```

Recommended modes:

```bash
# Safe local report (no Discord API calls, always exit 0)
npm run smoke:discord:dm-voice -- --dry-run --report-only

# Deployment gate (no Discord API calls, fail on readiness issues)
npm run smoke:discord:dm-voice -- --dry-run --strict

# Read-only live validation against Discord API (GET calls only)
npm run smoke:discord:dm-voice -- --live --strict \
  --dm-channel-id <dm_channel_id> \
  --voice-channel-id <voice_channel_id>
```

`--live` does not send messages or join channels; it only validates token/channel/user reachability via Discord REST GET endpoints.

## Troubleshooting

| Symptom from smoke/runtime logs | Likely cause | Fix |
| --- | --- | --- |
| `No Opus backend package detected` | Neither `@discordjs/opus` nor `opusscript` installed | Install one or both (`@discordjs/opus` preferred). |
| `prism-media decoder instantiation failed` / `Could not find an Opus module` | Backend package missing or unusable on host | Reinstall backend; if native build fails, use `opusscript` fallback. |
| `VOICE_ENABLED is not true` | Voice gate disabled by config | Set `VOICE_ENABLED=true` for voice deployments. |
| `Voice prerequisites missing: ...` | Missing guild/user/STT env vars | Populate required env vars listed above. |
| `Missing TTS config` | No usable TTS connector config | Provide `ELEVENLABS_API_KEY` or `ECHO_TTS_URL` + `ECHO_TTS_VOICE`. |
| `Target voice user membership check failed` in `--live` mode | Wrong guild/user IDs or bot cannot access guild member route | Verify IDs, guild membership, and bot permissions/intents. |
| DM works but voice does not start | Voice preflight disabled runtime | Run smoke script in strict mode; fix reported voice/Opus gaps. |

## Deployment checklist

1. Run `npm run smoke:discord:dm-voice -- --dry-run --strict`.
2. If Discord credentials are available, run `--live --strict` with known DM/voice channel IDs.
3. Run targeted Discord tests before rollout:
   - `vitest run src/channels/discord/adapter.test.ts src/channels/discord/voice.test.ts`
4. Deploy only when smoke + tests pass for the target environment.
