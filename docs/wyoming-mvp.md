# Wyoming MVP Validation Runbook (Voice PE + Home Assistant)

- Issue: `PSFN-slsv.6`
- Last updated: 2026-02-26
- Audience: operators validating the Home Assistant Voice Preview Edition (Voice PE) MVP flow.

## 1) MVP Topology and Goal

This runbook validates the Wyoming MVP contract for the Home Assistant-mediated Voice PE path:

```text
Voice PE (ESPHome satellite)
  -> Home Assistant Assist pipeline
    -> PSFN Wyoming service host
      -> agent response text
      -> TTS text payload
  <- Home Assistant playback orchestration
```

The objective is to prove both:

1. transcript -> agent -> speech round-trip behavior
2. interruption behavior (session end while `handle` is in flight)

## 2) Prerequisites

### 2.1 Required components

- Home Assistant instance with Assist enabled.
- Home Assistant Voice Preview Edition (Voice PE) added through ESPHome and visible in HA.
- PSFN checkout on branch `feat/PSFN-slsv-6`.
- Node.js 22+ with dependencies installed (`npm install`).
- Network reachability from Home Assistant to the PSFN Wyoming endpoint host/port.

### 2.2 Voice PE / HA worksheet (fill before test run)

| Field | Example | Notes |
| --- | --- | --- |
| HA URL | `http://homeassistant.local:8123` | Used for operator checks and logs. |
| HA user | `owner` | Used to map `ha_user_id`. |
| Voice PE device name | `Kitchen Voice PE` | Must be online in ESPHome integration. |
| `site_id` | `ha-main` | Stable site/group identifier. |
| `satellite_id` | `voice-pe-kitchen` | Stable per-device identifier. |
| Wyoming host | `192.168.1.40` | Host where PSFN Wyoming service is exposed. |
| Wyoming port | `10700` | Port for Wyoming TCP service. |
| Fallback Assist pipeline | `Home Assistant (local)` | Mandatory safety fallback when gateway path is unavailable. |

## 3) Startup Order (Operator Flow)

1. Start PSFN gateway and agent in separate terminals:

```bash
npm run gateway
npm run agent
```

2. Start the Wyoming smoke harness for contract-level validation:

```bash
npx tsx src/e2e-wyoming-roundtrip.ts
```

3. In Home Assistant, validate Voice PE availability:
- `Settings -> Devices & Services -> ESPHome`
- Confirm the Voice PE device is connected and has recent telemetry.

4. In Home Assistant Assist, configure pipeline routing for this MVP window:
- Select the Voice PE satellite.
- Route conversation handling to the PSFN Wyoming-backed pipeline.
- Keep a local/default fallback Assist pipeline configured and enabled.

## 4) MVP Test Matrix

| ID | Scenario | Hardware path | Expected result | Evidence |
| --- | --- | --- | --- | --- |
| `W-MVP-01` | Round-trip happy path | Voice PE -> HA Assist -> Wyoming `handle` | `handle.result` returns `transcript`, non-empty `agent_text`, and matching `tts_text` | Harness output + operator transcript snippet |
| `W-MVP-02` | Interruption / barge-in | Voice PE with early session close | No `handle.result` emitted after interruption; cancellation counted | Harness output (`Cancelled handle requests`) |
| `W-MVP-03` | Gateway unavailable fallback | Voice PE -> fallback Assist pipeline | User still gets response via fallback pipeline | HA Assist history and pipeline selection evidence |
| `W-MVP-04` | DIY satellite compatibility | Raspberry Pi Wyoming client -> same gateway | Same behavior as `W-MVP-01` and `W-MVP-02` | Operator notes with `site_id`/`satellite_id` mapping |

## 5) Automated Smoke Harness

Command:

```bash
npx tsx src/e2e-wyoming-roundtrip.ts
```

Pass criteria:

- `describe` emits `info` with `handle` service advertised.
- Round-trip session emits:
  - `ack` for `session.start`
  - `handle.result` with transcript + agent/tts text
  - `ack` for `session.end`
- Interruption session emits `session.end` ack and no post-close `handle.result`.
- Final summary shows `Failed: 0`.

## 6) Manual Voice PE Validation Script

Use these utterances during live Voice PE validation:

1. Round-trip probe:
- Say: `Status check alpha for kitchen satellite.`
- Expected: response references the same status phrase and audio playback completes.

2. Interruption probe:
- Say: `Read a long response so I can interrupt.`
- Interrupt quickly with: `Stop.`
- Expected: original response is cancelled/short-circuited and no stale completion continues playing.

## 7) Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| No `info` frame on `describe` | Wyoming runtime not started or transport path not wired | Verify gateway/service process is running and re-run `src/e2e-wyoming-roundtrip.ts` |
| `SESSION_NOT_FOUND` errors | Session lifecycle mismatch | Ensure every `handle` carries `session_id` and `session.start` occurs first |
| No response after Voice PE speech | Assist pipeline not targeting PSFN Wyoming path | Re-check Assist pipeline routing and selected satellite |
| Voice PE still responds but not from PSFN | Fallback pipeline is active | Confirm expected for outage test; switch pipeline back for MVP validation |
| Interruption still returns full response | Cancellation hook not applied in runtime integration | Validate onSessionEnd wiring and request cancellation propagation |

## 8) Known Limitations and Fallback Guidance

- This smoke harness validates Wyoming runtime contract behavior in-process; it does not replace full hardware-in-the-loop evidence.
- MVP identity mapping currently follows `api:wyoming:<siteId>:<satelliteId>` as defined in `docs/architecture/wyoming-mvp-adr.md`.
- Optional Wyoming `asr`/`tts` families may be disabled; `handle` is the required MVP surface.
- Keep HA local/default fallback pipeline configured so Voice PE remains usable during gateway outages/timeouts.
