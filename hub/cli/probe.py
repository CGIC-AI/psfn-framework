from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path
from typing import Annotated

import typer

from hub.config import ESPHomeTarget
from hub.devices.esphome_session import ESPHomeSession, ProbeSnapshot
from hub.devices.voice_flow import PCMFormatAssumption, VoiceTransportSpike
from hub.util import to_jsonable, write_json


def _build_target(
    *,
    host: str,
    port: int,
    noise_psk: str | None,
    password: str | None,
    expected_name: str | None,
) -> ESPHomeTarget:
    return ESPHomeTarget(
        host=host,
        port=port,
        noise_psk=noise_psk,
        password=password,
        expected_name=expected_name,
    )


async def _run_probe(
    *,
    host: str,
    port: int,
    noise_psk: str | None,
    password: str | None,
    expected_name: str | None,
    watch_seconds: float,
    output_path: Path | None,
) -> ProbeSnapshot:
    target = _build_target(
        host=host,
        port=port,
        noise_psk=noise_psk,
        password=password,
        expected_name=expected_name,
    )
    state_updates: list[dict[str, object]] = []
    async with ESPHomeSession(target) as session:
        device_info = await session.device_info()
        entities, services = await session.list_entities_services()

        if watch_seconds > 0:
            session.subscribe_states(
                lambda state: state_updates.append({"state": to_jsonable(state)})
            )
            await asyncio.sleep(watch_seconds)

    snapshot = ProbeSnapshot(
        device_info=device_info,
        entities=entities,
        services=services,
        state_updates=state_updates,
    )
    if output_path is not None:
        write_json(output_path, snapshot)
    return snapshot


def probe(
    host: Annotated[str, typer.Option(help="ESPHome device host or IP")],
    port: Annotated[int, typer.Option(help="ESPHome Native API port")] = 6053,
    noise_psk: Annotated[str | None, typer.Option(help="Noise PSK from ESPHome API encryption")] = None,
    password: Annotated[str | None, typer.Option(help="Legacy API password; usually leave unset")] = None,
    expected_name: Annotated[str | None, typer.Option(help="Expected device name guard")] = None,
    watch_seconds: Annotated[float, typer.Option(help="How long to watch state updates after probing")] = 5.0,
    output_path: Annotated[Path | None, typer.Option(help="Optional JSON output path")] = None,
) -> None:
    """Connect, fetch metadata, list entities/services, and watch state updates."""
    snapshot = asyncio.run(
        _run_probe(
            host=host,
            port=port,
            noise_psk=noise_psk,
            password=password,
            expected_name=expected_name,
            watch_seconds=watch_seconds,
            output_path=output_path,
        )
    )

    typer.echo(f"Name: {snapshot.device_info.name}")
    typer.echo(f"Friendly name: {getattr(snapshot.device_info, 'friendly_name', '')}")
    typer.echo(f"Model: {snapshot.device_info.model}")
    typer.echo(f"ESPHome version: {snapshot.device_info.esphome_version}")
    typer.echo(f"Voice assistant flags: {snapshot.device_info.voice_assistant_feature_flags}")
    typer.echo(f"Entities: {len(snapshot.entities)}")
    typer.echo(f"Services: {len(snapshot.services)}")
    typer.echo(f"State updates captured: {len(snapshot.state_updates)}")
    if output_path is not None:
        typer.echo(f"Wrote probe snapshot to {output_path}")


async def _run_transport_spike(
    *,
    host: str,
    port: int,
    noise_psk: str | None,
    password: str | None,
    expected_name: str | None,
    output_root: Path,
    duration_seconds: float | None,
    wav_sample_rate: int,
    wav_channels: int,
    wav_sample_width_bytes: int,
    response_port: int,
) -> None:
    target = _build_target(
        host=host,
        port=port,
        noise_psk=noise_psk,
        password=password,
        expected_name=expected_name,
    )
    spike = VoiceTransportSpike(
        output_root=output_root,
        pcm_format=PCMFormatAssumption(
            sample_rate=wav_sample_rate,
            channels=wav_channels,
            sample_width_bytes=wav_sample_width_bytes,
        ),
        listen_port=response_port,
    )
    async with ESPHomeSession(target) as session:
        device_info = await session.device_info()
        write_json(output_root / "device_info.json", device_info)
        unsubscribe = session.subscribe_voice_assistant(
            handle_start=spike.handle_start,
            handle_stop=spike.handle_stop,
            handle_audio=spike.handle_audio,
            handle_announcement_finished=spike.handle_announcement_finished,
        )
        typer.echo(f"Subscribed to voice assistant on {device_info.name} ({host}:{port})")
        typer.echo(f"Artifacts: {output_root}")
        typer.echo("Press Ctrl-C to stop")
        try:
            if duration_seconds is None:
                while True:
                    await asyncio.sleep(3600)
            else:
                await asyncio.sleep(duration_seconds)
        finally:
            unsubscribe()


def transport_spike(
    host: Annotated[str, typer.Option(help="ESPHome device host or IP")],
    port: Annotated[int, typer.Option(help="ESPHome Native API port")] = 6053,
    noise_psk: Annotated[str | None, typer.Option(help="Noise PSK from ESPHome API encryption")] = None,
    password: Annotated[str | None, typer.Option(help="Legacy API password; usually leave unset")] = None,
    expected_name: Annotated[str | None, typer.Option(help="Expected device name guard")] = None,
    output_root: Annotated[Path, typer.Option(help="Artifact root for voice captures")] = Path(".artifacts/voice"),
    duration_seconds: Annotated[float | None, typer.Option(help="Optional auto-stop timeout")] = None,
    wav_sample_rate: Annotated[int, typer.Option(help="WAV sample rate assumption for raw PCM")] = 16000,
    wav_channels: Annotated[int, typer.Option(help="WAV channel count assumption")] = 1,
    wav_sample_width_bytes: Annotated[int, typer.Option(help="WAV sample width in bytes")] = 2,
    response_port: Annotated[int, typer.Option(help="Port returned from handle_start; use 0 for API_AUDIO-first")] = 0,
) -> None:
    """Capture raw voice transport artifacts without STT or the Framework in the loop."""
    try:
        asyncio.run(
            _run_transport_spike(
                host=host,
                port=port,
                noise_psk=noise_psk,
                password=password,
                expected_name=expected_name,
                output_root=output_root,
                duration_seconds=duration_seconds,
                wav_sample_rate=wav_sample_rate,
                wav_channels=wav_channels,
                wav_sample_width_bytes=wav_sample_width_bytes,
                response_port=response_port,
            )
        )
    except KeyboardInterrupt:
        typer.echo("Stopped transport spike")
