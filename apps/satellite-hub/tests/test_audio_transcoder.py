from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

import pytest

from hub.media.audio_transcoder import FfmpegMp3ToFlacTranscoder

# ffmpeg/ffprobe are deployment-host dependencies for the Waveshare bridge
# (see apps/satellite-hub/README.md), not present in the clean CI runner.
requires_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="ffmpeg/ffprobe not installed in this environment",
)


def test_transcoder_fails_fast_when_ffmpeg_is_missing() -> None:
    with pytest.raises(RuntimeError, match="ffmpeg is required"):
        FfmpegMp3ToFlacTranscoder(executable="definitely-not-an-ffmpeg-binary")


@requires_ffmpeg
@pytest.mark.anyio
async def test_transcoder_produces_48khz_mono_flac(tmp_path: Path) -> None:
    source = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.2",
            "-f",
            "mp3",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    ).stdout

    async def chunks():
        for offset in range(0, len(source), 257):
            yield source[offset : offset + 257]

    output = bytearray()
    async for chunk in FfmpegMp3ToFlacTranscoder().transcode(chunks()):
        output.extend(chunk)

    flac_path = tmp_path / "speaker.flac"
    flac_path.write_bytes(output)
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name,sample_rate,channels",
            "-of",
            "json",
            str(flac_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    stream = json.loads(probe.stdout)["streams"][0]
    assert stream == {"codec_name": "flac", "sample_rate": "48000", "channels": 1}
