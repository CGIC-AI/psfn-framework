# Deployment-specific microWakeWord

Wake-word identity is local deployment data. Generated models, manifests,
pronunciations, hard negatives, evaluation output, and training provenance are
intentionally not tracked in this repository.

Firmware preparation retains the pinned upstream `alexa` model by default. To
use a local model, point the preparation command at an ignored ESPHome
microWakeWord manifest and provide the exact model digest:

```bash
PSFN_WAKE_WORD_MANIFEST=/absolute/path/to/wakeword.json \
PSFN_WAKE_WORD_SHA256=<64-hex-model-digest> \
PSFN_SATELLITE_TIMEZONE=UTC \
npm run firmware:prepare:waveshare-bedroom
```

The manifest's `model` field is resolved relative to the manifest. Preparation
fails if the manifest is malformed, the model is missing, or its digest does
not match. These inputs belong under an ignored local workspace or another
operator-controlled path.

## Training

The generic training pipeline remains available in
`scripts/train-waveshare-wakeword.py`. Its `synthesize` stage requires an
explicit ignored definitions directory containing `pronunciations.txt` and
`hard-negatives.txt`; it has no identity-bearing tracked default.

The exact microWakeWord and Piper Sample Generator revisions and downloadable
corpus checksums are recorded in `../source-lock.json`. Training uses Python
3.10 with the compatibility pins in `training-constraints.txt`. Generated
corpora, feature maps, checkpoints, and downloaded datasets should remain under
an ignored `.artifacts/training/` workspace.
