import { EndBehaviorType, type VoiceConnection } from '@discordjs/voice';
import type { VoiceInputCaptureOptions, VoiceTransportInput } from './types.js';

export class DiscordVoiceInputTransport implements VoiceTransportInput {
  private readonly connection: VoiceConnection;

  constructor(connection: VoiceConnection) {
    this.connection = connection;
  }

  onSpeakingStart(userId: string, onStart: () => void): () => void {
    const listener = (speakingUserId: string) => {
      if (speakingUserId === userId) {
        onStart();
      }
    };

    this.connection.receiver.speaking.on('start', listener);
    return () => {
      this.connection.receiver.speaking.off('start', listener);
    };
  }

  captureOpus({ userId, silenceDurationMs }: VoiceInputCaptureOptions): NodeJS.ReadableStream {
    return this.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: silenceDurationMs,
      },
    });
  }
}
