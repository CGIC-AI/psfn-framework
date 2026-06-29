import {
  AudioPlayerStatus,
  createAudioResource,
  entersState,
  type AudioPlayer,
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import { createRateLimitedLogEmitter } from '../../../shared/log-rate-limit.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { VoiceTransportOutput } from './types.js';

const PLAYBACK_START_TIMEOUT_MS = 5_000;
const PLAYBACK_FINISH_TIMEOUT_MS = 120_000;
const log = createComponentLogger('DiscordVoiceOutput');
const rateLimitedDebugLog = createRateLimitedLogEmitter({ windowMs: 60_000 });

export class DiscordVoiceOutputTransport implements VoiceTransportOutput {
  private readonly player: AudioPlayer;

  constructor(player: AudioPlayer) {
    this.player = player;
  }

  async playAudio(audio: Buffer): Promise<void> {
    const resource = createAudioResource(Readable.from(audio));
    this.player.play(resource);

    await entersState(this.player, AudioPlayerStatus.Playing, PLAYBACK_START_TIMEOUT_MS)
      .catch((error: unknown) => {
        const errorMessage = toErrorMessage(error);
        rateLimitedDebugLog(
          `discord.voice.playback_start:${errorMessage}`,
          () => log.debug('Discord voice playback did not enter playing state before timeout', {
            timeoutMs: PLAYBACK_START_TIMEOUT_MS,
            nextState: AudioPlayerStatus.Idle,
            error: errorMessage,
          }),
        );
      });
    await entersState(this.player, AudioPlayerStatus.Idle, PLAYBACK_FINISH_TIMEOUT_MS);
  }

  stop(): void {
    this.player.stop(true);
  }
}
