import {
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import { Events, type Client, type VoiceBasedChannel, type VoiceState } from 'discord.js';
import { Readable } from 'node:stream';
import type { EventBus } from '../../event-bus.js';
import { createComponentLogger } from '../../logger.js';
import type { SubstrateConfig, SubstrateMessage } from '../../types.js';
import { createWavFromPcm16le } from '../../voice/audio.js';
import { DeepgramSttClient } from '../../voice/deepgram.js';
import { ElevenLabsTtsClient } from '../../voice/elevenlabs.js';
import type { MessageHandler } from '../types.js';

const log = createComponentLogger('DiscordVoice');
const CAPTURE_SILENCE_MS = 1_200;
const MIN_PCM_BYTES = 32_000;

interface DiscordVoiceRuntimeConfig {
  client: Client;
  config: SubstrateConfig;
  eventBus: EventBus;
  getHandler: () => MessageHandler | null;
}

export class DiscordVoiceRuntime {
  private readonly client: Client;
  private readonly config: SubstrateConfig;
  private readonly eventBus: EventBus;
  private readonly getHandler: () => MessageHandler | null;

  private readonly enabled: boolean;
  private readonly targetGuildId: string;
  private readonly targetUserId: string;
  private readonly deepgram?: DeepgramSttClient;
  private readonly elevenLabs?: ElevenLabsTtsClient;

  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private activeChannel: VoiceBasedChannel | null = null;
  private speakingListener: ((userId: string) => void) | null = null;
  private capturing = false;
  private handlingState = false;

  constructor({ client, config, eventBus, getHandler }: DiscordVoiceRuntimeConfig) {
    this.client = client;
    this.config = config;
    this.eventBus = eventBus;
    this.getHandler = getHandler;

    this.targetGuildId = config.voiceTargetGuildId ?? '';
    this.targetUserId = config.voiceTargetUserId ?? '';

    const voiceEnabled = config.voiceEnabled === true;
    const deepgramApiKey = config.deepgramApiKey ?? '';
    const elevenLabsApiKey = config.elevenLabsApiKey ?? '';
    const elevenLabsVoiceId = config.elevenLabsVoiceId ?? '';

    if (!voiceEnabled) {
      this.enabled = false;
      return;
    }

    if (!this.targetGuildId || !this.targetUserId || !deepgramApiKey || !elevenLabsApiKey || !elevenLabsVoiceId) {
      this.enabled = false;
      log.warn('Voice enabled but missing required config, disabling voice runtime', {
        hasGuild: !!this.targetGuildId,
        hasUser: !!this.targetUserId,
        hasDeepgram: !!deepgramApiKey,
        hasElevenLabs: !!elevenLabsApiKey,
        hasVoiceId: !!elevenLabsVoiceId,
      });
      return;
    }

    this.deepgram = new DeepgramSttClient({
      apiKey: deepgramApiKey,
      model: config.deepgramModel,
    });
    this.elevenLabs = new ElevenLabsTtsClient({
      apiKey: elevenLabsApiKey,
      voiceId: elevenLabsVoiceId,
      modelId: config.elevenLabsModelId,
    });
    this.enabled = true;
  }

  init(): void {
    if (!this.enabled) return;

    this.client.on(Events.VoiceStateUpdate, this.onVoiceStateUpdate);
    log.info('Discord voice runtime enabled', {
      guildId: this.targetGuildId,
      userId: this.targetUserId,
    });
  }

  async stop(): Promise<void> {
    if (!this.enabled) return;

    this.client.off(Events.VoiceStateUpdate, this.onVoiceStateUpdate);
    await this.leaveChannel('shutdown');
  }

  private onVoiceStateUpdate = async (oldState: VoiceState, newState: VoiceState): Promise<void> => {
    if (!this.enabled) return;
    if (this.handlingState) return;
    this.handlingState = true;

    try {
      const guildId = newState.guild.id;
      if (guildId !== this.targetGuildId) return;

      if (this.activeChannel && this.nonBotMemberCount(this.activeChannel) === 0) {
        await this.leaveChannel('channel-empty');
      }

      if (newState.id !== this.targetUserId) return;

      const nextChannel = newState.channel;
      if (!nextChannel) {
        await this.leaveChannel('target-left');
        return;
      }

      if (this.activeChannel?.id === nextChannel.id) return;

      await this.joinChannel(nextChannel);
    } catch (error) {
      this.emitVoiceError(error);
    } finally {
      this.handlingState = false;
    }
  };

  private async joinChannel(channel: VoiceBasedChannel): Promise<void> {
    await this.leaveChannel('switch-channel');

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

    const player = createAudioPlayer();
    connection.subscribe(player);

    this.connection = connection;
    this.player = player;
    this.activeChannel = channel;

    this.speakingListener = (userId: string) => {
      if (userId !== this.targetUserId || this.capturing) return;
      this.handleUtterance().catch((error) => this.emitVoiceError(error));
    };
    connection.receiver.speaking.on('start', this.speakingListener);

    await this.eventBus.emit('channel.voice.start', {
      guildId: channel.guild.id,
      channelId: channel.id,
      userId: this.targetUserId,
    });

    const readyCue = this.config.voiceReadyCueText?.trim();
    if (readyCue) {
      await this.speakText(readyCue);
    }
  }

  private async leaveChannel(reason: string): Promise<void> {
    const prevChannel = this.activeChannel;
    if (!prevChannel && !this.connection) return;

    if (this.connection && this.speakingListener) {
      this.connection.receiver.speaking.off('start', this.speakingListener);
    }
    this.speakingListener = null;

    if (this.player) {
      this.player.stop(true);
    }

    if (this.connection) {
      this.connection.destroy();
    }

    this.connection = null;
    this.player = null;
    this.activeChannel = null;
    this.capturing = false;

    if (prevChannel) {
      await this.eventBus.emit('channel.voice.end', {
        guildId: prevChannel.guild.id,
        channelId: prevChannel.id,
        userId: this.targetUserId,
        reason,
      });
    }
  }

  private async handleUtterance(): Promise<void> {
    if (!this.connection || !this.player || !this.activeChannel || !this.deepgram || !this.elevenLabs) return;

    this.capturing = true;
    try {
      const opusStream = this.connection.receiver.subscribe(this.targetUserId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: CAPTURE_SILENCE_MS,
        },
      });

      const pcm = await this.decodeOpusToPcm(opusStream);
      if (pcm.length < MIN_PCM_BYTES) return;

      const wav = createWavFromPcm16le(pcm, 48_000, 2);
      const transcript = (await this.deepgram.transcribeWav(wav)).trim();
      if (!transcript) return;

      await this.eventBus.emit('channel.voice.transcript', {
        guildId: this.activeChannel.guild.id,
        channelId: this.activeChannel.id,
        userId: this.targetUserId,
        transcript,
      });

      const handler = this.getHandler();
      if (!handler) return;

      const member = this.activeChannel.members.get(this.targetUserId);
      const message: SubstrateMessage = {
        id: `voice-${Date.now()}`,
        channelId: `discord-voice:${this.activeChannel.id}`,
        channelType: 'discord',
        isDirectMessage: false,
        authorId: this.targetUserId,
        authorName: member?.displayName ?? member?.user.username ?? 'Voice User',
        content: transcript,
        timestamp: new Date(),
      };

      await this.eventBus.emit('message.received', { message });
      const response = await handler(message);
      await this.eventBus.emit('message.sent', { response });

      const text = response.content.trim();
      if (!text) {
        log.warn('Voice response was empty; skipping TTS playback');
        return;
      }

      await this.speakText(text);
      await this.eventBus.emit('channel.voice.tts.sent', {
        guildId: this.activeChannel.guild.id,
        channelId: this.activeChannel.id,
        userId: this.targetUserId,
        text,
      });
    } finally {
      this.capturing = false;
    }
  }

  private async speakText(text: string): Promise<void> {
    if (!this.player || !this.elevenLabs) return;

    const audio = await this.elevenLabs.synthesize(text);
    const resource = createAudioResource(Readable.from(audio));
    this.player.play(resource);

    await entersState(this.player, AudioPlayerStatus.Playing, 5_000).catch(() => undefined);
    await entersState(this.player, AudioPlayerStatus.Idle, 120_000);
  }

  private async decodeOpusToPcm(opusStream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const decoder = new prism.opus.Decoder({
        rate: 48_000,
        channels: 2,
        frameSize: 960,
      });
      const chunks: Buffer[] = [];
      let total = 0;

      decoder.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
      });
      decoder.once('end', () => {
        resolve(Buffer.concat(chunks, total));
      });
      decoder.once('error', (error: Error) => reject(error));
      opusStream.once('error', (error: Error) => reject(error));

      opusStream.pipe(decoder);
    });
  }

  private nonBotMemberCount(channel: VoiceBasedChannel): number {
    return channel.members.filter(member => !member.user.bot).size;
  }

  private emitVoiceError(error: unknown): void {
    const errorText = error instanceof Error ? error.message : String(error);
    log.error('Voice pipeline error', { error: errorText });

    this.eventBus.emit('channel.voice.error', {
      guildId: this.activeChannel?.guild.id,
      channelId: this.activeChannel?.id,
      userId: this.targetUserId,
      error: errorText,
    }).catch(() => undefined);
  }
}
