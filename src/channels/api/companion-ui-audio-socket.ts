import { randomUUID } from 'node:crypto';
import type {
  CompanionUiAudioIngressPort,
  CompanionUiAudioIngressSession,
} from '../../boundary/gateway/companion-ui-audio-ingress.js';
import type { HubDeviceAttachmentSnapshot } from '../../shared/contracts/hub-device-ingress.js';
import {
  parseCompanionUiAudioChunk,
  parseCompanionUiAudioControlFrame,
  type CompanionUiAudioControlFrame,
} from '../../shared/contracts/companion-ui-audio.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { isObjectRecord as isRecord } from '../../shared/utils/types.js';

const log = createComponentLogger('CompanionUiAudioSocket');

interface ActiveAudioStream {
  readonly requestId: string;
  readonly session: CompanionUiAudioIngressSession;
  nextSequence: number;
  pendingWrites: number;
  writeChain: Promise<void>;
  interactionId?: string;
  interactionController?: AbortController;
  interruptedInteractionId?: string;
  stopping: boolean;
}

export interface CompanionUiAudioSocketOptions {
  readonly enabled: boolean;
  readonly companionId: CompanionId;
  readonly ingress: CompanionUiAudioIngressPort;
  readonly maxPendingFrames: number;
  readonly send: (value: unknown) => void;
  readonly refreshAuthority: () => Promise<void>;
  readonly attachment: () => HubDeviceAttachmentSnapshot;
  readonly reserveRequestId: (requestId: string) => void;
  readonly dispatchAction: (body: Uint8Array, signal: AbortSignal) => Promise<unknown>;
  readonly screenTranscript: (input: Readonly<{
    companionId: CompanionId;
    attachment: HubDeviceAttachmentSnapshot;
    requestId: string;
    transcript: string;
  }>) => Promise<string>;
  readonly cancelInteraction: (input: Readonly<{
    companionId: CompanionId;
    attachment: HubDeviceAttachmentSnapshot;
    interactionId: string;
  }>) => Promise<void>;
  readonly terminateSocket: (reason: string) => void;
}

function tryParseControl(body: Uint8Array): CompanionUiAudioControlFrame | undefined {
  try {
    return parseCompanionUiAudioControlFrame(body);
  } catch {
    return undefined;
  }
}

function responseContent(result: unknown): string {
  if (!isRecord(result) || typeof result.content !== 'string') {
    throw new Error('Companion audio response was malformed');
  }
  return result.content;
}

function reportCancellationFailure(error: unknown): void {
  log.warn('Companion UI audio cancellation failed', {
    errorType: error instanceof Error ? error.name : typeof error,
  });
}

/**
 * Owns the lifetime of one socket's optional PCM stream. The surrounding
 * WebSocket adapter retains admission and authority refresh; this module owns
 * only audio framing, backpressure, turn boundaries, and teardown.
 */
export class CompanionUiAudioSocketSession {
  private closed = false;
  private startingRequestId: string | null = null;
  private active: ActiveAudioStream | null = null;

  constructor(private readonly options: CompanionUiAudioSocketOptions) {}

  handleBinary(raw: Uint8Array): void {
    const audio = this.active;
    if (this.closed || !audio || audio.stopping) {
      throw new Error('audio stream not ready');
    }
    const chunk = parseCompanionUiAudioChunk(raw);
    if (chunk.sequence !== audio.nextSequence
      || audio.pendingWrites >= this.options.maxPendingFrames) {
      throw new Error('audio sequence or backpressure violation');
    }
    audio.nextSequence = (audio.nextSequence + 1) >>> 0;
    audio.pendingWrites += 1;
    audio.writeChain = audio.writeChain
      .then(async () => {
        await audio.session.writePcm(chunk.pcm);
        if (!this.closed && this.active === audio) {
          this.options.send({
            schemaVersion: 1,
            type: 'audio.ack',
            requestId: audio.requestId,
            sequence: chunk.sequence,
          });
        }
      })
      .catch(() => { this.fail(audio, 'audio write failed'); })
      .finally(() => { audio.pendingWrites -= 1; });
  }

  async tryHandleControl(body: Uint8Array): Promise<boolean> {
    const control = tryParseControl(body);
    if (!control) return false;
    if (control.type === 'audio.start') {
      await this.start(control.requestId);
      return true;
    }
    const audio = this.active;
    if (!audio || audio.requestId !== control.requestId) {
      throw new Error('audio stream mismatch');
    }
    if (control.type === 'audio.interrupt') {
      if (audio.stopping) throw new Error('audio stream mismatch');
      await this.interrupt(audio);
      this.options.send({
        schemaVersion: 1,
        type: 'event',
        event: { type: 'action', data: 'interrupt' },
      });
      return true;
    }
    audio.stopping = true;
    await this.interrupt(audio);
    await audio.writeChain;
    if (this.closed || this.active !== audio) return true;
    await audio.session.stop('client stop');
    if (this.active === audio) this.active = null;
    this.options.send({
      schemaVersion: 1,
      type: 'audio.stopped',
      requestId: audio.requestId,
    });
    return true;
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.startingRequestId = null;
    const audio = this.active;
    this.active = null;
    if (audio) this.cancel(audio, reason);
  }

  private async start(requestId: string): Promise<void> {
    if (!this.options.enabled || this.closed || this.startingRequestId || this.active) {
      throw new Error('audio stream denied');
    }
    this.options.reserveRequestId(requestId);
    this.startingRequestId = requestId;
    const state = { failed: false };
    const isCurrent = () => !this.closed && this.startingRequestId === requestId;
    try {
      await this.options.refreshAuthority();
      if (!isCurrent()) return;
      const session = await this.options.ingress.start({
        companionId: this.options.companionId,
        onPartial: text => {
          if (!this.closed && this.active?.requestId === requestId) {
            this.sendConversation('user', text, { live: true });
          }
        },
        onUtterance: text => this.deliverUtterance(requestId, text),
        onError: () => {
          if (this.active?.requestId === requestId) {
            this.fail(this.active, 'STT stream failed');
          } else if (this.startingRequestId === requestId) {
            state.failed = true;
          }
        },
      });
      if (!isCurrent() || state.failed) {
        await session.cancel('audio start superseded').catch(reportCancellationFailure);
        if (state.failed) throw new Error('audio stream failed during startup');
        return;
      }
      this.active = {
        requestId,
        session,
        nextSequence: 0,
        pendingWrites: 0,
        writeChain: Promise.resolve(),
        stopping: false,
      };
      this.options.send({ schemaVersion: 1, type: 'audio.ready', requestId });
    } finally {
      if (this.startingRequestId === requestId) this.startingRequestId = null;
    }
  }

  private async interrupt(audio: ActiveAudioStream): Promise<void> {
    const interactionId = audio.interactionId;
    if (!interactionId) return;
    audio.interactionController?.abort('Companion audio interrupted');
    audio.interruptedInteractionId = interactionId;
    await this.options.refreshAuthority();
    await this.options.cancelInteraction({
      companionId: this.options.companionId,
      attachment: this.options.attachment(),
      interactionId,
    });
  }

  private async deliverUtterance(requestId: string, transcript: string): Promise<void> {
    const streamIsActive = () => !this.closed && this.active?.requestId === requestId;
    if (!streamIsActive()) return;
    const actionRequestId = randomUUID();
    await this.options.refreshAuthority();
    const effectiveTranscript = await this.options.screenTranscript({
      companionId: this.options.companionId,
      attachment: this.options.attachment(),
      requestId: actionRequestId,
      transcript,
    });
    if (!streamIsActive()) return;
    this.options.reserveRequestId(actionRequestId);
    const body = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      requestId: actionRequestId,
      action: 'companion.interact',
      resource: 'conversation.audio',
      body: { transcript: effectiveTranscript },
    }));
    const audio = this.active;
    if (!audio || audio.requestId !== requestId) return;
    const interactionController = new AbortController();
    audio.interactionId = actionRequestId;
    audio.interactionController = interactionController;
    this.options.send({ schemaVersion: 1, type: 'audio.turn.started', requestId });
    this.sendConversation('user', effectiveTranscript, { final: true });
    try {
      const content = responseContent(await this.options.dispatchAction(
        body,
        interactionController.signal,
      ));
      if (streamIsActive()
        && audio.interruptedInteractionId !== actionRequestId
        && content) {
        this.sendConversation('assistant', content, { final: true });
      }
    } catch (error) {
      if (audio.interruptedInteractionId !== actionRequestId) throw error;
    } finally {
      if (audio.interactionId === actionRequestId) delete audio.interactionId;
      if (audio.interactionController === interactionController) {
        delete audio.interactionController;
      }
      if (audio.interruptedInteractionId === actionRequestId) {
        delete audio.interruptedInteractionId;
      }
      if (streamIsActive()) {
        this.options.send({ schemaVersion: 1, type: 'audio.turn.ended', requestId });
      }
    }
  }

  private fail(audio: ActiveAudioStream, reason: string): void {
    if (this.closed || this.active !== audio) return;
    this.options.send({
      schemaVersion: 1,
      type: 'event',
      event: {
        type: 'error-event',
        data: { message: 'Companion audio relay failed' },
      },
    });
    this.active = null;
    this.cancel(audio, reason);
    this.closed = true;
    this.startingRequestId = null;
    this.options.terminateSocket('audio relay failed');
  }

  private cancel(audio: ActiveAudioStream, reason: string): void {
    audio.interactionController?.abort(reason);
    if (audio.interactionId) {
      void this.options.cancelInteraction({
        companionId: this.options.companionId,
        attachment: this.options.attachment(),
        interactionId: audio.interactionId,
      }).catch(reportCancellationFailure);
    }
    void audio.session.cancel(reason).catch(reportCancellationFailure);
  }

  private sendConversation(
    role: 'user' | 'assistant',
    content: string,
    state: Readonly<{ live: true } | { final: true }>,
  ): void {
    this.options.send({
      schemaVersion: 1,
      type: 'event',
      event: {
        type: 'message',
        data: { role, content, ...state },
      },
    });
  }
}
