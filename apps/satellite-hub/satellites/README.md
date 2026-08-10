# Satellite Firmware Catalog

This directory owns firmware and device-local runtime assets for PSFN satellite
endpoints. Each deployable hardware target gets one self-contained directory.
Board-specific pin maps, build inputs, local UI assets, and recovery notes stay
with that target instead of accumulating conditionals in a universal firmware.

The directory name describes the deployed endpoint, not merely the MCU. For
example, `waveshare-bedroom` is the static bedroom endpoint built on the
Waveshare ESP32-S3 Touch LCD 1.85C-BOX V2. A future generic ESP32 endpoint,
CrowPanel endpoint, or Pi display endpoint will receive a sibling directory.

Use this shape inside a target when the files are needed:

```text
satellites/<endpoint>/
  README.md                 hardware, build, recovery, and deployment contract
  source-lock.json          immutable upstream revisions and fetched artifacts
  secrets.example.yaml     required local-only configuration keys
  esphome/                  ESPHome YAML and local components
  assets/                   device-local display/audio assets
  LICENSES/                 licenses for incorporated upstream material
```

Do not add a shared abstraction just because another target might need it.
Promote code into `satellites/shared/` only after at least two working targets
use the same contract and the hardware differences are understood.

Secrets and generated ESPHome build state are ignored by git. Committed files
must use placeholders or secret references; no Wi-Fi, API, encryption, or
device credentials belong in this tree.
