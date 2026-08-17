from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path

import typer
from aioesphomeapi.model import MediaPlayerInfo

from hub.adapters.agent.psfn_streaming import PsfnStreamingProvider
from hub.adapters.stt.deepgram_live import DeepgramLiveSTTProvider
from hub.adapters.tts.elevenlabs_streaming import ElevenLabsStreamingTTS
from hub.devices.esphome_session import ESPHomeSession
from hub.devices.interaction_runtime import (
    ESPHomeInteractionRecorder,
    SatelliteInteraction,
    deliver_interaction,
    find_headpat_signal_key,
)
from hub.devices.realtime_server import RealtimeVoiceServer
from hub.devices.voice_runtime_streaming import StreamingVoiceAssistantRuntime
from hub.media.http_audio import StaticAudioServer
from hub.runtime import load_runtime_config
from hub.storage.session_cache import SessionCache


async def _run_esphome_runtime(
    *,
    config,
    audio_server: StaticAudioServer,
    session_cache: SessionCache,
) -> None:
    assert config.esphome_target is not None
    stt = DeepgramLiveSTTProvider(api_key=config.deepgram_api_key)
    tts = ElevenLabsStreamingTTS(
        api_key=config.elevenlabs_api_key,
        voice_id=config.elevenlabs_voice_id,
        model_id=config.elevenlabs_model_id,
    )
    agent = PsfnStreamingProvider(
        api_base_url=config.psfn_api_base_url,
        api_key=config.psfn_api_key,
        provider_name=config.psfn_provider,
        model_name=config.psfn_model,
        author_id=config.psfn_author_id,
        author_name=config.psfn_author_name,
        claim_config=config.psfn_satellite_claim,
        client_certificate=config.psfn_client_certificate,
    )
    interaction_tasks: set[asyncio.Task[None]] = set()

    async def deliver_headpat(interaction: SatelliteInteraction) -> None:
        try:
            result = await deliver_interaction(
                interaction,
                submitter=agent,
                conversation_id=config.voice_conversation_id,
            )
            response = result.get("response", "").strip()
            detail = f": {response}" if response else ""
            typer.echo(f"Headpat delivered to Companion{detail}")
        except Exception as exc:
            typer.echo(f"Headpat delivery failed: {exc}")

    try:
        while True:
            try:
                async with ESPHomeSession(config.esphome_target) as session:
                    device_info = await session.device_info()
                    entities, _ = await session.list_entities_services()
                    media_player_key = next(
                        (entity.key for entity in entities if isinstance(entity, MediaPlayerInfo)),
                        None,
                    )
                    headpat_signal_key = find_headpat_signal_key(entities)
                    if headpat_signal_key is not None:
                        interaction_recorder = ESPHomeInteractionRecorder(
                            headpat_signal_key=headpat_signal_key,
                            endpoint_id=config.psfn_satellite_claim.endpoint_id,
                            artifacts_root=config.artifacts_root,
                        )

                        def handle_interaction_state(state) -> None:
                            interaction = interaction_recorder.handle_state(state)
                            if interaction is not None:
                                typer.echo(
                                    f"Interaction received: {interaction.interaction_type} "
                                    f"from {interaction.endpoint_id}",
                                )
                                task = asyncio.create_task(deliver_headpat(interaction))
                                interaction_tasks.add(task)
                                task.add_done_callback(interaction_tasks.discard)

                        session.subscribe_states(handle_interaction_state)
                    runtime = StreamingVoiceAssistantRuntime(
                        session=session,
                        stt=stt,
                        agent=agent,
                        tts=tts,
                        audio_server=audio_server,
                        session_cache=session_cache,
                        artifacts_root=config.artifacts_root,
                        continue_conversation=config.continue_conversation,
                        announcement_timeout_seconds=config.announcement_timeout_seconds,
                        reply_timeout_seconds=config.reply_timeout_seconds,
                        initial_silence_timeout_seconds=config.voice_initial_silence_timeout_seconds,
                        endpointing_grace_seconds=config.voice_endpointing_grace_seconds,
                        silence_timeout_seconds=config.voice_silence_timeout_seconds,
                        max_turn_seconds=config.voice_max_turn_seconds,
                        speech_rms_threshold=config.voice_speech_rms_threshold,
                        min_speech_chunks_for_endpointing=config.voice_min_speech_chunks_for_endpointing,
                        media_player_key=media_player_key,
                        pinned_conversation_id=config.voice_conversation_id,
                    )
                    unsubscribe = session.subscribe_voice_assistant(
                        handle_start=runtime.handle_start,
                        handle_stop=runtime.handle_stop,
                        handle_audio=runtime.handle_audio,
                    )
                    try:
                        typer.echo(
                            f"Connected to {device_info.friendly_name or device_info.name} at "
                            f"{config.esphome_target.host}:{config.esphome_target.port}"
                        )
                        await session.wait_disconnected()
                    finally:
                        unsubscribe()
                typer.echo("ESPHome connection lost; reconnecting in 2 seconds")
            except Exception as exc:
                typer.echo(f"ESPHome connection failed: {exc}; reconnecting in 5 seconds")
                await asyncio.sleep(5)
                continue
            await asyncio.sleep(2)
    finally:
        for task in interaction_tasks:
            task.cancel()
        if interaction_tasks:
            await asyncio.gather(*interaction_tasks, return_exceptions=True)
        audio_server.stop()
        await agent.aclose()
        await stt.aclose()
        await tts.aclose()


async def _run_realtime_runtime(
    *,
    config,
    audio_server: StaticAudioServer,
    session_cache: SessionCache,
) -> None:
    async with RealtimeVoiceServer(
        host=config.realtime_target.bind_host,
        port=config.realtime_target.port,
        artifacts_root=config.artifacts_root,
        audio_server=audio_server,
        session_cache=session_cache,
        deepgram_api_key=config.deepgram_api_key,
        elevenlabs_api_key=config.elevenlabs_api_key,
        elevenlabs_voice_id=config.elevenlabs_voice_id,
        elevenlabs_model_id=config.elevenlabs_model_id,
        psfn_api_base_url=config.psfn_api_base_url,
        psfn_api_key=config.psfn_api_key,
        psfn_provider=config.psfn_provider,
        psfn_model=config.psfn_model,
        psfn_author_id=config.psfn_author_id,
        psfn_author_name=config.psfn_author_name,
        psfn_satellite_claim=config.psfn_satellite_claim,
        psfn_client_certificate=config.psfn_client_certificate,
    ):
        while True:
            await asyncio.sleep(3600)


async def _run_runtime(project_root: Path) -> None:
    config = load_runtime_config(project_root)
    audio_server = StaticAudioServer(
        host=config.audio_bind_host,
        port=config.audio_port,
        root=config.audio_root,
        public_host=config.audio_public_host,
        public_port=config.audio_public_port,
    )
    audio_server.start()
    session_cache = SessionCache(ttl=timedelta(seconds=config.session_ttl_seconds))

    typer.echo(f"Device transport: {config.device_transport}")
    typer.echo(f"PSFN API base: {config.psfn_api_base_url}")
    if config.psfn_provider:
        typer.echo(f"PSFN provider override: {config.psfn_provider}")
    typer.echo(f"PSFN model: {config.psfn_model}")
    if config.psfn_author_id and config.psfn_author_name:
        typer.echo(f"PSFN author assertion: {config.psfn_author_name} ({config.psfn_author_id})")
    typer.echo(f"Audio server: http://{config.audio_public_host}:{config.audio_public_port}/")
    if config.device_transport in {"realtime", "hybrid"}:
        realtime_host = config.realtime_target.public_host or config.realtime_target.bind_host
        typer.echo(f"Realtime voice server: ws://{realtime_host}:{config.realtime_target.port}/")
    typer.echo("Voice bridge is running. Press Ctrl-C to stop.")

    try:
        async with asyncio.TaskGroup() as task_group:
            if config.device_transport in {"esphome", "hybrid"}:
                task_group.create_task(
                    _run_esphome_runtime(
                        config=config,
                        audio_server=audio_server,
                        session_cache=session_cache,
                    )
                )
            if config.device_transport in {"realtime", "hybrid"}:
                task_group.create_task(
                    _run_realtime_runtime(
                        config=config,
                        audio_server=audio_server,
                        session_cache=session_cache,
                    )
                )
    finally:
        audio_server.stop()


def run() -> None:
    """Run the end-to-end voice bridge for the configured ESPHome endpoint."""
    try:
        asyncio.run(_run_runtime(Path.cwd()))
    except KeyboardInterrupt:
        typer.echo("Stopped voice bridge")
