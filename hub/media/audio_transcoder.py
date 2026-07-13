from __future__ import annotations

import asyncio
from collections.abc import AsyncIterable, AsyncIterator
from contextlib import suppress
import shutil
from typing import Protocol


class StreamingAudioTranscoder(Protocol):
    def transcode(self, chunks: AsyncIterable[bytes]) -> AsyncIterator[bytes]: ...


class FfmpegMp3ToFlacTranscoder:
    """Convert ElevenLabs MP3 chunks to the Waveshare's 48 kHz mono FLAC."""

    def __init__(self, *, executable: str = "ffmpeg") -> None:
        resolved = shutil.which(executable)
        if resolved is None:
            raise RuntimeError(
                "ffmpeg is required for Waveshare voice playback (ElevenLabs MP3 to 48 kHz mono FLAC)",
            )
        self._executable = resolved

    async def transcode(self, chunks: AsyncIterable[bytes]) -> AsyncIterator[bytes]:
        process = await asyncio.create_subprocess_exec(
            self._executable,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "mp3",
            "-i",
            "pipe:0",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-c:a",
            "flac",
            "-f",
            "flac",
            "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        assert process.stderr is not None

        async def feed_input() -> None:
            try:
                async for chunk in chunks:
                    if not chunk:
                        continue
                    process.stdin.write(chunk)
                    await process.stdin.drain()
            finally:
                process.stdin.close()
                with suppress(BrokenPipeError, ConnectionResetError):
                    await process.stdin.wait_closed()

        feeder = asyncio.create_task(feed_input())
        try:
            while output := await process.stdout.read(16 * 1024):
                yield output
            await feeder
            return_code = await process.wait()
            if return_code != 0:
                detail = (await process.stderr.read()).decode("utf-8", errors="replace").strip()
                raise RuntimeError(f"ffmpeg MP3-to-FLAC transcode failed ({return_code}): {detail}")
        finally:
            if not feeder.done():
                feeder.cancel()
                with suppress(asyncio.CancelledError):
                    await feeder
            if process.returncode is None:
                process.kill()
                await process.wait()
