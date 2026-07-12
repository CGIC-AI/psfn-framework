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
speaking, and error. A deliberate tap on the head is a headpat. Horizontal
swipes enter a bedroom-device carousel; only configured room affordances may be
controlled.

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

This full upstream image uses a single large factory application partition and
therefore cannot perform OTA recovery or updates. USB serial remains the update
path until the unused SIP/VoIP and artwork surface is removed and a dual-slot
partition layout fits.
