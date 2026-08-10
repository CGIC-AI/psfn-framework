from __future__ import annotations

import asyncio
import base64
from collections import deque
from dataclasses import dataclass
import json
import logging
import os
from pathlib import Path
from queue import Empty, Full, Queue
import sys
import threading
import time
from typing import Any

import numpy as np

# soundcard currently assumes argv[1] exists when inferring a Pulse client name.
if len(sys.argv) < 2:
    sys.argv.append("psfn-realtime-client")

import soundcard as sc
import websockets
from websockets.exceptions import ConnectionClosed

LOG = logging.getLogger("psfn_realtime_client")


@dataclass(slots=True)
class AudioChunk:
    audio: bytes
    rms: float
    captured_at: float


@dataclass(slots=True)
class ClientConfig:
    hub_url: str
    device_id: str
    device_name: str
    conversation_id: str | None
    pactl_bin: str
    mic_sensitivity_percent: int
    mic_gain: float
    capture_sample_rate: int
    sample_rate: int
    input_channels: int
    channel_strategy: str
    capture_block_size: int
    block_size: int
    start_threshold: float
    ambient_start_ratio: float
    fast_start_ratio: float
    continue_threshold: float
    interrupt_ratio: float
    start_chunks: int
    min_speech_chunks: int
    speech_release_seconds: float
    initial_silence_timeout: float
    end_silence_timeout: float
    max_turn_seconds: float
    preroll_chunks: int
    preroll_lead_chunks: int
    reconnect_delay: float
    ffplay_bin: str
    ffplay_log_level: str
    ffplay_volume: float
    idle_log_interval: float
    candidate_log_ratio: float


class StreamingAudioPlayer:
    def __init__(self, *, ffplay_bin: str, log_level: str, volume: float) -> None:
        self._ffplay_bin = ffplay_bin
        self._log_level = log_level
        self._volume = volume
        self._process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._wait_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        async with self._lock:
            await self._stop_locked()
            self._process = await asyncio.create_subprocess_exec(
                self._ffplay_bin,
                "-autoexit",
                "-nodisp",
                "-hide_banner",
                "-loglevel",
                self._log_level,
                "-fflags",
                "nobuffer",
                "-flags",
                "low_delay",
                "-volume",
                str(int(self._volume * 100)),
                "-i",
                "pipe:0",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )

    async def write(self, data: bytes) -> None:
        if not data:
            return
        async with self._lock:
            process = self._process
            if process is None or process.returncode is not None or process.stdin is None:
                return
            process.stdin.write(data)
            await process.stdin.drain()

    async def finish(self) -> None:
        async with self._lock:
            process = self._process
            if process is None or process.returncode is not None:
                self._process = None
                return
            if process.stdin is not None and not process.stdin.is_closing():
                process.stdin.close()
            if self._wait_task is None or self._wait_task.done():
                self._wait_task = asyncio.create_task(self._wait_for_exit(process))

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_locked()

    async def _stop_locked(self) -> None:
        if self._wait_task is not None:
            self._wait_task.cancel()
            self._wait_task = None
        process = self._process
        self._process = None
        if process is None:
            return
        if process.returncode is None:
            process.kill()
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except TimeoutError:
                return

    async def _wait_for_exit(self, process: asyncio.subprocess.Process) -> None:
        try:
            await process.wait()
        except asyncio.CancelledError:
            return
        finally:
            if self._process is process:
                self._process = None


class PiRealtimeVoiceClient:
    def __init__(self, config: ClientConfig) -> None:
        self._config = config
        self._send_lock = asyncio.Lock()
        self._capture_queue: Queue[AudioChunk] = Queue(maxsize=256)
        self._preroll: deque[AudioChunk] = deque(maxlen=config.preroll_chunks)
        self._capture_stop = threading.Event()
        self._capture_thread: threading.Thread | None = None
        self._player = StreamingAudioPlayer(
            ffplay_bin=config.ffplay_bin,
            log_level=config.ffplay_log_level,
            volume=config.ffplay_volume,
        )
        self._ws: websockets.ClientConnection | None = None
        self._assistant_active = False
        self._assistant_audio_active = False
        self._turn_active = False
        self._turn_started_at = 0.0
        self._last_speech_at = 0.0
        self._speech_chunks = 0
        self._activation_chunks = 0
        self._playback_floor = 0.0
        self._playback_floor_samples = 0
        self._ambient_floor = 0.0
        self._ambient_floor_samples = 0
        self._last_idle_log_at = 0.0
        self._last_candidate_log_at = 0.0
        self._speech_started = False
        self._pending_silence: list[AudioChunk] = []
        self._user_speaking = False
        self._last_voice_activity_at = 0.0

    async def run(self) -> None:
        await self._configure_audio_stack()
        self._ensure_capture_thread()
        while True:
            try:
                async with websockets.connect(
                    self._config.hub_url,
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=None,
                ) as websocket:
                    LOG.info("Connected to hub: %s", self._config.hub_url)
                    self._ws = websocket
                    self._reset_turn_state()
                    await self._send_json(
                        {
                            "type": "hello",
                            "device_id": self._config.device_id,
                            "device_name": self._config.device_name,
                            "conversation_id": self._config.conversation_id,
                        }
                    )
                    async with asyncio.TaskGroup() as task_group:
                        task_group.create_task(self._reader_loop(websocket))
                        task_group.create_task(self._microphone_loop(websocket))
            except Exception as exc:
                LOG.warning("Realtime client disconnected: %s", exc)
                await self._player.stop()
                self._ws = None
                self._reset_turn_state()
                await asyncio.sleep(self._config.reconnect_delay)

    async def aclose(self) -> None:
        self._capture_stop.set()
        if self._capture_thread is not None:
            self._capture_thread.join(timeout=2)
        await self._player.stop()

    async def _reader_loop(self, websocket: websockets.ClientConnection) -> None:
        async for raw_message in websocket:
            if isinstance(raw_message, bytes):
                continue
            payload = json.loads(raw_message)
            await self._handle_server_message(payload)

    async def _microphone_loop(self, websocket: websockets.ClientConnection) -> None:
        while websocket.state.name == "OPEN":
            chunk = await asyncio.to_thread(self._next_chunk)
            if chunk is None:
                continue
            await self._handle_microphone_chunk(chunk)

    async def _handle_server_message(self, payload: dict[str, Any]) -> None:
        message_type = str(payload.get("type") or "")
        if message_type in {"session.ready", "hello.ack"}:
            LOG.info("%s: %s", message_type, payload)
            return
        if message_type == "assistant.start":
            self._assistant_active = True
            return
        if message_type == "assistant.text":
            delta = str(payload.get("delta") or "")
            if delta:
                LOG.info("assistant> %s", delta)
            return
        if message_type == "assistant.audio.start":
            self._assistant_active = True
            self._assistant_audio_active = True
            self._reset_playback_floor()
            await self._player.start()
            return
        if message_type == "assistant.audio.chunk":
            self._assistant_audio_active = True
            await self._player.write(_decode_audio(str(payload.get("audio") or "")))
            return
        if message_type == "assistant.audio.end":
            self._assistant_audio_active = False
            await self._player.finish()
            return
        if message_type in {"assistant.end", "assistant.cancelled", "assistant.interrupted"}:
            self._assistant_active = False
            self._assistant_audio_active = False
            self._reset_playback_floor()
            if message_type != "assistant.end":
                await self._player.stop()
            return
        if message_type == "turn.no_input":
            LOG.info("turn.no_input")
            return
        if message_type == "error":
            LOG.error("Hub error: %s", payload.get("message"))
            return

    async def _handle_microphone_chunk(self, chunk: AudioChunk) -> None:
        if self._ws is None:
            return

        self._preroll.append(chunk)
        self._update_playback_floor(chunk.rms)
        self._update_ambient_floor(chunk.rms)
        now = time.monotonic()

        threshold = self._config.start_threshold
        if self._ambient_floor > 0.0:
            threshold = max(threshold, self._ambient_floor * self._config.ambient_start_ratio)
        interrupting = self._assistant_active or self._assistant_audio_active
        if interrupting:
            threshold = max(threshold, self._playback_floor * self._config.interrupt_ratio)

        voice_hit = chunk.rms >= self._config.continue_threshold
        start_hit = chunk.rms >= threshold
        fast_start_hit = chunk.rms >= (threshold * self._config.fast_start_ratio)
        was_user_speaking = self._user_speaking
        if start_hit or (self._user_speaking and voice_hit):
            self._user_speaking = True
            self._last_voice_activity_at = now
        elif self._user_speaking and (now - self._last_voice_activity_at) >= self._config.speech_release_seconds:
            self._user_speaking = False

        if not self._turn_active:
            self._maybe_log_idle_metrics(chunk.rms, threshold, interrupting)
            if start_hit:
                self._activation_chunks += 1
                self._maybe_log_candidate(chunk.rms, threshold, self._config.start_chunks, interrupting)
            else:
                self._activation_chunks = 0
            if (not was_user_speaking and self._user_speaking) and (
                fast_start_hit or self._activation_chunks >= self._config.start_chunks or interrupting
            ):
                await self._begin_turn(interrupt=interrupting)
                self._activation_chunks = 0
            return

        if self._user_speaking and voice_hit:
            if self._pending_silence:
                for pending in self._pending_silence:
                    await self._send_audio(pending.audio)
                self._pending_silence.clear()
            await self._send_audio(chunk.audio)
            self._speech_chunks += 1
            self._speech_started = True
            self._last_speech_at = now
        elif self._speech_started:
            self._pending_silence.append(chunk)

        if not self._speech_started:
            if now - self._turn_started_at >= self._config.initial_silence_timeout:
                await self._end_turn("initial_silence_timeout")
            return

        if self._speech_chunks >= self._config.min_speech_chunks:
            if now - self._last_speech_at >= self._config.end_silence_timeout:
                await self._end_turn("vad_end")
                return

        if now - self._turn_started_at >= self._config.max_turn_seconds:
            await self._end_turn("max_turn_timeout")

    async def _begin_turn(self, *, interrupt: bool) -> None:
        if self._ws is None or self._turn_active:
            return
        if interrupt:
            LOG.info("Interrupting local playback on user speech")
            await self._player.stop()
            self._assistant_active = False
            self._assistant_audio_active = False
            self._reset_playback_floor()
            await self._send_json({"type": "interrupt"})

        await self._send_json({"type": "turn.start"})
        self._turn_active = True
        self._turn_started_at = time.monotonic()
        self._last_speech_at = self._turn_started_at
        self._last_voice_activity_at = self._turn_started_at
        self._speech_chunks = 0
        self._speech_started = False
        self._pending_silence.clear()

        buffered = _slice_preroll(
            list(self._preroll),
            threshold=self._config.continue_threshold,
            lead_chunks=self._config.preroll_lead_chunks,
        )
        self._preroll.clear()
        for item in buffered:
            await self._send_audio(item.audio)
            if item.rms >= self._config.continue_threshold:
                self._speech_chunks += 1
                self._speech_started = True
                self._last_speech_at = time.monotonic()
        LOG.info("Started turn with %s preroll chunks", len(buffered))

    async def _end_turn(self, reason: str) -> None:
        if self._ws is None or not self._turn_active:
            return
        await self._send_json({"type": "turn.end", "reason": reason})
        LOG.info("Ended turn: %s", reason)
        self._turn_active = False
        self._speech_chunks = 0
        self._speech_started = False
        self._pending_silence.clear()
        self._user_speaking = False
        self._last_voice_activity_at = 0.0
        self._turn_started_at = 0.0
        self._last_speech_at = 0.0

    async def _send_audio(self, audio: bytes) -> None:
        await self._send_json({"type": "audio", "audio": _encode_audio(audio)})

    async def _send_json(self, payload: dict[str, Any]) -> None:
        async with self._send_lock:
            if self._ws is None:
                return
            await self._ws.send(json.dumps(payload))

    async def _configure_audio_stack(self) -> None:
        if self._config.mic_sensitivity_percent <= 0:
            return
        try:
            process = await asyncio.create_subprocess_exec(
                self._config.pactl_bin,
                "set-source-volume",
                "@DEFAULT_SOURCE@",
                f"{self._config.mic_sensitivity_percent}%",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            LOG.warning("pactl not found, leaving source volume unchanged")
            return
        _, stderr = await process.communicate()
        if process.returncode == 0:
            LOG.info("Set source volume to %s%%", self._config.mic_sensitivity_percent)
            return
        LOG.warning(
            "Failed to set source volume to %s%%: %s",
            self._config.mic_sensitivity_percent,
            stderr.decode("utf-8", errors="ignore").strip(),
        )

    def _ensure_capture_thread(self) -> None:
        if self._capture_thread is not None:
            return
        self._capture_thread = threading.Thread(target=self._capture_microphone, daemon=True)
        self._capture_thread.start()

    def _capture_microphone(self) -> None:
        microphone = sc.default_microphone()
        LOG.info(
            "Using microphone: %s (capture_rate=%s sample_rate=%s channels=%s capture_block=%s)",
            microphone.name,
            self._config.capture_sample_rate,
            self._config.sample_rate,
            self._config.input_channels,
            self._config.capture_block_size,
        )
        with microphone.recorder(
            samplerate=self._config.capture_sample_rate,
            channels=self._config.input_channels,
            blocksize=self._config.capture_block_size,
        ) as mic:
            while not self._capture_stop.is_set():
                frames = mic.record(self._config.capture_block_size).astype(np.float32)
                if frames.ndim == 2:
                    frames = _collapse_channels(frames, self._config.channel_strategy)
                else:
                    frames = frames.reshape(-1)
                if self._config.mic_gain != 1.0:
                    frames *= self._config.mic_gain
                    np.clip(frames, -1.0, 1.0, out=frames)
                frames = _resample_audio(frames, self._config.capture_sample_rate, self._config.sample_rate)
                rms = float(np.sqrt(np.mean(np.square(frames, dtype=np.float32))))
                audio = (np.clip(frames, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
                item = AudioChunk(audio=audio, rms=rms, captured_at=time.monotonic())
                try:
                    self._capture_queue.put_nowait(item)
                except Full:
                    try:
                        self._capture_queue.get_nowait()
                    except Empty:
                        pass
                    try:
                        self._capture_queue.put_nowait(item)
                    except Full:
                        continue

    def _maybe_log_idle_metrics(self, rms: float, threshold: float, interrupting: bool) -> None:
        now = time.monotonic()
        if (now - self._last_idle_log_at) < self._config.idle_log_interval:
            return
        self._last_idle_log_at = now
        LOG.info(
            "Idle audio rms=%.4f ambient=%.4f playback=%.4f threshold=%.4f activation=%s interrupting=%s",
            rms,
            self._ambient_floor,
            self._playback_floor,
            threshold,
            self._activation_chunks,
            interrupting,
        )

    def _maybe_log_candidate(
        self,
        rms: float,
        threshold: float,
        required_chunks: int,
        interrupting: bool,
    ) -> None:
        now = time.monotonic()
        if rms < (threshold * self._config.candidate_log_ratio):
            return
        if (now - self._last_candidate_log_at) < 0.35:
            return
        self._last_candidate_log_at = now
        LOG.info(
            "Speech candidate rms=%.4f threshold=%.4f activation=%s/%s interrupting=%s",
            rms,
            threshold,
            self._activation_chunks,
            required_chunks,
            interrupting,
        )

    def _next_chunk(self) -> AudioChunk | None:
        try:
            return self._capture_queue.get(timeout=1.0)
        except Empty:
            return None

    def _update_playback_floor(self, rms: float) -> None:
        if not self._assistant_audio_active or self._turn_active:
            self._reset_playback_floor()
            return
        if rms <= 0.0:
            return
        if self._playback_floor_samples == 0:
            self._playback_floor = rms
            self._playback_floor_samples = 1
            return
        if self._playback_floor_samples < 12:
            self._playback_floor = max(self._playback_floor, rms)
            self._playback_floor_samples += 1
            return
        if rms < self._playback_floor * 0.85:
            self._playback_floor = (self._playback_floor * 0.98) + (rms * 0.02)

    def _update_ambient_floor(self, rms: float) -> None:
        if self._turn_active or self._assistant_audio_active:
            return
        if rms <= 0.0:
            return
        if self._ambient_floor_samples == 0:
            self._ambient_floor = rms
            self._ambient_floor_samples = 1
            return
        if self._ambient_floor_samples < 32:
            self._ambient_floor = (self._ambient_floor * self._ambient_floor_samples + rms) / (
                self._ambient_floor_samples + 1
            )
            self._ambient_floor_samples += 1
            return
        self._ambient_floor = (self._ambient_floor * 0.98) + (rms * 0.02)

    def _reset_playback_floor(self) -> None:
        self._playback_floor = 0.0
        self._playback_floor_samples = 0

    def _reset_turn_state(self) -> None:
        self._turn_active = False
        self._assistant_active = False
        self._assistant_audio_active = False
        self._speech_chunks = 0
        self._speech_started = False
        self._pending_silence.clear()
        self._user_speaking = False
        self._last_voice_activity_at = 0.0
        self._activation_chunks = 0
        self._preroll.clear()
        self._ambient_floor = 0.0
        self._ambient_floor_samples = 0
        self._reset_playback_floor()


def load_config() -> ClientConfig:
    return ClientConfig(
        hub_url=_required_env("HUB_WS_URL"),
        device_id=_required_env("DEVICE_ID"),
        device_name=_required_env("DEVICE_NAME"),
        conversation_id=_optional_env("CONVERSATION_ID"),
        pactl_bin=os.getenv("PACTL_BIN", "/usr/bin/pactl"),
        mic_sensitivity_percent=int(os.getenv("MIC_SENSITIVITY_PERCENT", "100")),
        mic_gain=float(os.getenv("MIC_GAIN", "1.0")),
        capture_sample_rate=int(os.getenv("MIC_CAPTURE_SAMPLE_RATE", "16000")),
        sample_rate=int(os.getenv("MIC_SAMPLE_RATE", "16000")),
        input_channels=int(os.getenv("MIC_INPUT_CHANNELS", "1")),
        channel_strategy=os.getenv("MIC_CHANNEL_STRATEGY", "best").strip().lower(),
        capture_block_size=int(os.getenv("MIC_CAPTURE_BLOCK_SIZE", "512")),
        block_size=int(os.getenv("MIC_BLOCK_SIZE", "512")),
        start_threshold=float(os.getenv("VOICE_START_THRESHOLD", "0.005")),
        ambient_start_ratio=float(os.getenv("VOICE_AMBIENT_START_RATIO", "2.5")),
        fast_start_ratio=float(os.getenv("VOICE_FAST_START_RATIO", "1.0")),
        continue_threshold=float(os.getenv("VOICE_CONTINUE_THRESHOLD", "0.004")),
        interrupt_ratio=float(os.getenv("VOICE_INTERRUPT_RATIO", "1.0")),
        start_chunks=int(os.getenv("VOICE_START_CHUNKS", "1")),
        min_speech_chunks=int(os.getenv("VOICE_MIN_SPEECH_CHUNKS", "2")),
        speech_release_seconds=float(os.getenv("VOICE_SPEECH_RELEASE_SECONDS", "0.18")),
        initial_silence_timeout=float(os.getenv("VOICE_INITIAL_SILENCE_TIMEOUT_SECONDS", "1.4")),
        end_silence_timeout=float(os.getenv("VOICE_END_SILENCE_TIMEOUT_SECONDS", "0.7")),
        max_turn_seconds=float(os.getenv("VOICE_MAX_TURN_SECONDS", "20")),
        preroll_chunks=int(os.getenv("VOICE_PREROLL_CHUNKS", "32")),
        preroll_lead_chunks=int(os.getenv("VOICE_PREROLL_LEAD_CHUNKS", "4")),
        reconnect_delay=float(os.getenv("RECONNECT_DELAY_SECONDS", "2.0")),
        ffplay_bin=os.getenv("FFPLAY_BIN", "/usr/bin/ffplay"),
        ffplay_log_level=os.getenv("FFPLAY_LOG_LEVEL", "error"),
        ffplay_volume=float(os.getenv("PLAYBACK_VOLUME", "1.0")),
        idle_log_interval=float(os.getenv("VOICE_IDLE_LOG_INTERVAL_SECONDS", "1.0")),
        candidate_log_ratio=float(os.getenv("VOICE_CANDIDATE_LOG_RATIO", "0.75")),
    )


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _optional_env(name: str) -> str | None:
    value = os.getenv(name, "").strip()
    return value or None


def configure_logging() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


async def _main() -> None:
    configure_logging()
    client = PiRealtimeVoiceClient(load_config())
    try:
        await client.run()
    finally:
        await client.aclose()


def main() -> None:
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        return


def _encode_audio(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _decode_audio(value: str) -> bytes:
    return base64.b64decode(value) if value else b""


def _collapse_channels(frames: np.ndarray, strategy: str) -> np.ndarray:
    if frames.ndim != 2:
        return frames.reshape(-1)
    if strategy == "left":
        return frames[:, 0]
    if strategy == "right":
        return frames[:, min(1, frames.shape[1] - 1)]
    if strategy == "average":
        return frames.mean(axis=1)
    channel_rms = np.sqrt(np.mean(np.square(frames), axis=0, dtype=np.float32))
    return frames[:, int(np.argmax(channel_rms))]


def _resample_audio(frames: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    if from_rate == to_rate or frames.size == 0:
        return frames
    if from_rate % to_rate == 0:
        factor = from_rate // to_rate
        trimmed = frames[: frames.size - (frames.size % factor)]
        if trimmed.size == 0:
            return frames
        return trimmed.reshape(-1, factor).mean(axis=1)
    duration = frames.size / float(from_rate)
    target_samples = max(1, int(round(duration * to_rate)))
    source_positions = np.linspace(0.0, 1.0, num=frames.size, endpoint=False, dtype=np.float32)
    target_positions = np.linspace(0.0, 1.0, num=target_samples, endpoint=False, dtype=np.float32)
    return np.interp(target_positions, source_positions, frames).astype(np.float32)


def _slice_preroll(buffered: list[AudioChunk], *, threshold: float, lead_chunks: int) -> list[AudioChunk]:
    first_voiced_index: int | None = None
    for index, item in enumerate(buffered):
        if item.rms >= threshold:
            first_voiced_index = index
            break
    if first_voiced_index is None:
        return []
    start_index = max(0, first_voiced_index - max(0, lead_chunks))
    return buffered[start_index:]


if __name__ == "__main__":
    main()
