# Purrsephone microWakeWord

This directory defines the local wake word for the Waveshare bedroom
satellite. The phrase is bare **Purrsephone**; `Hey` is deliberately not part
of the model. `pronunciations.txt` contains the three accepted IPA variants,
including the elongated initial *purr*. `hard-negatives.txt` contains phrases
that should not open a turn.

Large generated corpora, feature maps, checkpoints, and downloaded datasets
belong under the ignored `.artifacts/training/purrsephone/` workspace. Only the
final quantized TFLite model and its ESPHome manifest are checked in.

## Pinned inputs

The exact microWakeWord and Piper Sample Generator revisions, downloadable
corpus checksums, and generator-model checksum are recorded in
`../source-lock.json`. Training uses Python 3.10 with the compatibility pins in
`training-constraints.txt`.

`datasets` 5.x is intentionally excluded. Its TorchCodec audio path imports
Triton into the TensorFlow feature process and crashes on this environment.
The older loader is also the API contemporary with the pinned microWakeWord
revision.

The synthetic speaker model is Piper Sample Generator's
`en_US-libritts_r-medium.pt` v2.0.0 release. The four precomputed negative
feature archives are downloaded from the `kahrendt/microwakeword` Hugging Face
dataset: `speech`, `no_speech`, `dinner_party`, and `dinner_party_eval`.

## Feature generation

Generate the positive and hard-negative WAV corpora directly from the tracked
definitions, then seed the Piper room augmentation and resampling to 16 kHz:

```bash
.artifacts/training/venv/bin/python scripts/train-waveshare-wakeword.py \
  synthesize --workspace .artifacts/training/purrsephone \
  --piper-generator .artifacts/training/piper-sample-generator \
  --piper-model .artifacts/training/piper-sample-generator/models/en_US-libritts_r-medium.pt

.artifacts/training/venv/bin/python scripts/train-waveshare-wakeword.py \
  augment --workspace .artifacts/training/purrsephone \
  --piper-generator .artifacts/training/piper-sample-generator
```

Build the memory-mapped features and configuration from the repository root:

```bash
PYTHONPATH=.artifacts/training/micro-wake-word \
  .artifacts/training/venv/bin/python scripts/train-waveshare-wakeword.py \
  positive-features --workspace .artifacts/training/purrsephone

PYTHONPATH=.artifacts/training/micro-wake-word \
  .artifacts/training/venv/bin/python scripts/train-waveshare-wakeword.py \
  hard-negative-features --workspace .artifacts/training/purrsephone

PYTHONPATH=.artifacts/training/micro-wake-word \
  .artifacts/training/venv/bin/python scripts/train-waveshare-wakeword.py \
  config --workspace .artifacts/training/purrsephone
```

The recipe uses a 1.5-second input window, explicitly upweights near-name hard
negatives, and selects checkpoints by ambient false positives per hour before
maximizing viable recall.

## Training

TensorFlow's pip-installed NVIDIA libraries are not on WSL's default dynamic
linker path. Add every package-local NVIDIA `lib` directory and enable the
growth allocator before launching training; otherwise TensorFlow either falls
back to CPU or attempts to reserve almost all VRAM.

```bash
NVIDIA_LIBS=$(find "$PWD/.artifacts/training/venv/lib/python3.10/site-packages/nvidia" \
  -type d -name lib -printf '%p:')
export LD_LIBRARY_PATH="${NVIDIA_LIBS}${LD_LIBRARY_PATH:-}"
export TF_FORCE_GPU_ALLOW_GROWTH=true
export PYTHONPATH="$PWD/.artifacts/training/micro-wake-word"

.artifacts/training/venv/bin/python -m microwakeword.model_train_eval \
  --training_config="$PWD/.artifacts/training/purrsephone/training-parameters.yaml" \
  --train 1 --restore_checkpoint 1 \
  --test_tf_nonstreaming 0 --test_tflite_nonstreaming 0 \
  --test_tflite_nonstreaming_quantized 0 --test_tflite_streaming 0 \
  --test_tflite_streaming_quantized 1 --use_weights best_weights \
  mixednet --pointwise_filters "64,64,64,64" \
  --repeat_in_block "1, 1, 1, 1" \
  --mixconv_kernel_sizes '[5], [7,11], [9,15], [23]' \
  --residual_connection "0,0,0,0" \
  --first_conv_filters 32 --first_conv_kernel_size 5 --stride 3
```

The deployable output is
`trained-model/tflite_stream_state_internal_quant/stream_state_internal_quant.tflite`.
The manifest cutoff must come from the selected checkpoint's ambient
evaluation, not from the training-batch accuracy.

The initial 15,000-step model uses cutoff `0.93`. Its held-out quantized
streaming evaluation measured `0.375` false accepts/hour and a `0.020`
false-reject rate. These synthetic-corpus numbers are the starting threshold;
real recordings from the installed bedroom device remain the authority for
subsequent tuning.

`training-provenance.json` identifies the exact ignored corpus and feature sets
used for the checked-in model. `tflite-streaming-roc.txt` is the converter's
held-out quantized-streaming report. The seed and source pins make reruns
auditable; GPU training is not claimed to be byte-identical across different
CUDA/TensorFlow stacks.
