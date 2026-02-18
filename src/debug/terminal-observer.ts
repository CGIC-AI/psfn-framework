import type { EventBus } from '../event-bus.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('TerminalDebug');

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1'
    || normalized === 'true'
    || normalized === 'yes'
    || normalized === 'on';
}

export function isTerminalDebugEnabled(): boolean {
  return envFlag('PSFN_DEBUG_MODE') || envFlag('PSFN_DEBUG_TERMINAL');
}

interface TerminalDebugOptions {
  scope: string;
}

type StreamKind = 'thinking' | 'delta';

interface StreamState {
  thinkingOpen: boolean;
  deltaOpen: boolean;
}

function writeStreamChunk(
  streamByChannel: Map<string, StreamState>,
  scope: string,
  channelId: string,
  kind: StreamKind,
  chunk: string,
): void {
  if (!chunk) return;

  const state = streamByChannel.get(channelId) ?? { thinkingOpen: false, deltaOpen: false };
  const key = kind === 'thinking' ? 'thinkingOpen' : 'deltaOpen';
  if (!state[key]) {
    process.stderr.write(`\n[debug:${scope}:${kind}:${channelId}] `);
    state[key] = true;
  }
  process.stderr.write(chunk);
  streamByChannel.set(channelId, state);
}

function closeStreams(streamByChannel: Map<string, StreamState>, channelId: string): void {
  const state = streamByChannel.get(channelId);
  if (!state) return;
  if (state.thinkingOpen || state.deltaOpen) {
    process.stderr.write('\n');
  }
  streamByChannel.delete(channelId);
}

export function attachTerminalDebugObserver(
  eventBus: EventBus,
  options: TerminalDebugOptions,
): () => void {
  if (!isTerminalDebugEnabled()) return () => {};

  const showEvents = envFlag('PSFN_DEBUG_EVENTS', true);
  const showThinking = envFlag('PSFN_DEBUG_THINKING', true);
  const showDeltas = envFlag('PSFN_DEBUG_TEXT', true);
  const streamByChannel = new Map<string, StreamState>();

  log.warn('Terminal debug mode enabled', {
    scope: options.scope,
    showEvents,
    showThinking,
    showDeltas,
  });

  const unsubs: Array<() => void> = [];

  if (showEvents) {
    unsubs.push(eventBus.on('message.received', ({ message }) => {
      log.debug('Debug event', {
        scope: options.scope,
        event: 'message.received',
        channelId: message.channelId,
        authorId: message.authorId,
      });
    }));

    unsubs.push(eventBus.on('message.sent', ({ response }) => {
      log.debug('Debug event', {
        scope: options.scope,
        event: 'message.sent',
        channelId: response.channelId,
        durationMs: response.metadata.durationMs,
      });
    }));

    unsubs.push(eventBus.on('agent.turn.start', ({ message }) => {
      closeStreams(streamByChannel, message.channelId);
      log.info('Debug turn start', {
        scope: options.scope,
        channelId: message.channelId,
        authorId: message.authorId,
      });
    }));

    unsubs.push(eventBus.on('agent.turn.end', ({ message, response }) => {
      closeStreams(streamByChannel, message.channelId);
      log.info('Debug turn end', {
        scope: options.scope,
        channelId: message.channelId,
        model: response.metadata.model,
        durationMs: response.metadata.durationMs,
        inputTokens: response.metadata.inputTokens,
        outputTokens: response.metadata.outputTokens,
      });
    }));

    unsubs.push(eventBus.on('agent.tool.start', ({ channelId, toolCallId, toolName }) => {
      log.debug('Debug tool start', {
        scope: options.scope,
        channelId,
        toolCallId,
        toolName,
      });
    }));

    unsubs.push(eventBus.on('agent.tool.end', ({ channelId, toolCallId, toolName, isError }) => {
      log.debug('Debug tool end', {
        scope: options.scope,
        channelId,
        toolCallId,
        toolName,
        isError,
      });
    }));

    unsubs.push(eventBus.on('memory.extraction.end', (data) => {
      log.debug('Debug extraction', {
        scope: options.scope,
        ...data,
      });
    }));

    unsubs.push(eventBus.on('memory.retrieval', (data) => {
      log.debug('Debug retrieval', {
        scope: options.scope,
        ...data,
      });
    }));

    unsubs.push(eventBus.on('agent.error', ({ message, error }) => {
      closeStreams(streamByChannel, message.channelId);
      log.error('Debug agent error', {
        scope: options.scope,
        channelId: message.channelId,
        error: error.message,
      });
    }));
  }

  if (showThinking) {
    unsubs.push(eventBus.on('agent.stream.thinking', ({ channelId, text }) => {
      writeStreamChunk(streamByChannel, options.scope, channelId, 'thinking', text);
    }));
  }

  if (showDeltas) {
    unsubs.push(eventBus.on('agent.stream.delta', ({ channelId, text }) => {
      writeStreamChunk(streamByChannel, options.scope, channelId, 'delta', text);
    }));
  }

  if (showEvents) {
    unsubs.push(eventBus.on('agent.turn.stage', (data) => {
      log.debug('Debug turn stage', {
        scope: options.scope,
        ...data,
      });
    }));

    unsubs.push(eventBus.on('channel.queue.telemetry', (data) => {
      log.debug('Debug queue telemetry', {
        scope: options.scope,
        ...data,
      });
    }));
  }

  return () => {
    for (const unsubscribe of unsubs) {
      unsubscribe();
    }
    for (const channelId of streamByChannel.keys()) {
      closeStreams(streamByChannel, channelId);
    }
  };
}
