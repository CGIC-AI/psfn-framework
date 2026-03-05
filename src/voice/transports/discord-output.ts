import {
  AudioPlayerStatus,
  createAudioResource,
  entersState,
  type AudioPlayer,
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import type { VoiceTransportOutput } from './types.js';

const PLAYBACK_START_TIMEOUT_MS = 5_000;
const PLAYBACK_FINISH_TIMEOUT_MS = 120_000;

export class DiscordVoiceOutputTransport implements VoiceTransportOutput {
  private readonly player: AudioPlayer;

  constructor(player: AudioPlayer) {
    this.player = player;
  }

  async playAudio(audio: Buffer): Promise<void> {
    const resource = createAudioResource(Readable.from(audio));
    this.player.play(resource);

    await entersState(this.player, AudioPlayerStatus.Playing, PLAYBACK_START_TIMEOUT_MS)
      .catch(() => { /* Playback start timeout — continue to wait for idle */ });
    await entersState(this.player, AudioPlayerStatus.Idle, PLAYBACK_FINISH_TIMEOUT_MS);
  }

  stop(): void {
    this.player.stop(true);
  }
}
