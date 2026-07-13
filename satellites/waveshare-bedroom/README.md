# Waveshare Bedroom Satellite

Static bedroom voice-and-touch satellite for Purrsephone.

## Confirmed Hardware

- Waveshare ESP32-S3-Touch-LCD-1.85C-BOX V2
- ESP32-S3 revision 0.2, 16 MB flash, 8 MB octal PSRAM
- ST77916 360x360 round QSPI display
- CST816 capacitive touch controller
- ES7210 dual-microphone ADC
- ES8311 speaker DAC and onboard amplifier/speaker path
- Native USB Serial/JTAG at `/dev/ttyACM0` when attached to WSL

The factory firmware reported successful initialization of the display, touch,
both audio codecs, two-microphone AFE, AEC, speech enhancement, WakeNet, and
VAD. Its only observed peripheral error was the expected absence of an SD card.

## Product Contract

The endpoint is a private, static satellite bound to the PSFN `bedroom` place.
It keeps wake-word detection, audio-front-end processing, VAD, immediate touch
feedback, and display state local. PSFN Satellite Hub owns STT, Purrsephone turn
routing, TTS, endpoint authentication, and bounded Home Assistant control.

The first UI uses replaceable pixel-art states for idle, listening, thinking,
speaking, and error. Wake detection immediately raises the backlight to full
brightness and shows a purple `Listening...` label over Purrsephone's idle
sprite. A deliberate tap on the head is a headpat. Horizontal
swipes enter a bedroom-device carousel; only configured room affordances may be
controlled.

The exact live Home Assistant affordances are recorded in
`home-assistant.rooms.json`. The bedroom satellite is anchored to the physical
`bedroom` place and presents bedroom/upstairs controls first, followed by the
office/downstairs group. Indicator lights, timers, configuration entities,
cameras, and sirens are deliberately excluded. The two PIRs provide one
latched, coarse location hint: only motion rising edges count, repeated motion
in the current room is ignored, and motion in the other room moves the hint
there. Inactive edges do nothing and the hint never expires. Raw PIR changes do
not create chat turns or PSFN event traffic.

Presence sensing is not part of this sealed-unit build. The LD2410C requires a
5 V supply capable of more than 200 mA, which the exposed 3.3 V breakout cannot
provide safely.

## Upstream Baseline

The hardware/audio baseline comes from the MIT-licensed experimental
`ESP32-S3-Touch-LCD-1.85C-BOX V2` profile in `n-IA-hane/esphome-intercom`.
`source-lock.json` records immutable revisions. Production firmware must not
use floating `main`, `master`, or `latest` references.

## Local Configuration

Copy `esphome/secrets.example.yaml` to `esphome/secrets.yaml` and fill the local
values. `secrets.yaml` is ignored by git.

The factory image is backed up outside git under
`.artifacts/hardware/waveshare-1.85c-v2/` before replacement. Chunk files retain
their flash offsets in their filenames so they can be restored independently.

## Verified Baseline

The pinned profile compiles with ESPHome 2026.6.5 and has been flashed over
native USB. Boot logs confirm Wi-Fi association, ES7210 input, ES8311 output,
TDM audio startup, and more than 7 MB free PSRAM after audio initialization.
The local override keeps executable code and the large read-only UI assets in
flash; the upstream setting attempted to copy more than 9 MB into 8 MB PSRAM
and rebooted before `setup()`.

The encrypted native API exposes `start_voice_turn` and `stop_voice_turn` as a
stable push-to-talk seam. A Pi-side transport probe invoked the start action and
captured more than 1.4 MB of live microphone PCM. The repo-owned bare
`Purrsephone` microWakeWord model is trained from the three pronunciations and
near-name exclusions under `wakeword/`. Its training recipe selects checkpoints
by ambient false activations before recall; touch-to-talk remains available
independently of the wake detector.

The physical GPIO0 button remains the push-to-talk fallback. A short press on
the idle face is reserved for headpats and is not repurposed for voice input.

The compiled runtime binds the repo-owned bare `Purrsephone` model directly to
ESPHome's local microWakeWord component. Detection starts the ESPHome native
voice-assistant stream, which is consumed by the Pi-side Satellite Hub fallback
bridge. Home Assistant Assist is not in the conversation path. The bridge runs
as `psfn-waveshare-bedroom.service`, performs streaming Deepgram STT, sends the
turn through the authenticated PSFN bedroom endpoint, and returns Purrsephone's
ElevenLabs stream to the onboard speaker.
The bridge requires `ffmpeg` to convert ElevenLabs MP3 chunks into the 48 kHz
mono FLAC format advertised by this firmware's speaker pipeline.

This full upstream image uses a single large factory application partition and
therefore cannot perform OTA recovery or updates. USB serial remains the update
path until the unused SIP/VoIP and artwork surface is removed and a dual-slot
partition layout fits.

## Purrsephone Sprites

Firmware-ready 360x360 RGBA assets live under `assets/sprites/`. The preparation
script flood-removes only near-white background pixels connected to an image
edge, which removes the baked checkerboard without erasing her white hair or
clothes:

```bash
uv run --with pillow python scripts/prepare-waveshare-sprites.py \
  /path/to/source-sprites satellites/waveshare-bedroom/assets/sprites
```

The current baseline displays idle art while idle, listening, or disconnected;
thinking art during inference; talking art during reply playback; and sleeping
art while offline. Tool-use and sleeping are also embedded for the custom
three-page runtime to select explicitly once the borrowed intercom controller is
removed.
