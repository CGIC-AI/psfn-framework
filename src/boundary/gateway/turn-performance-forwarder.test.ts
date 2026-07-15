import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { buildTurnPerformanceEvent } from '../../shared/telemetry/turn-performance.js';
import { attachGatewayTurnPerformanceForwarder } from './turn-performance-forwarder.js';

describe('attachGatewayTurnPerformanceForwarder', () => {
  it('forwards gateway-process performance events and detaches cleanly', async () => {
    const eventBus = new EventBus();
    const requestAgentTurnPerformance = vi.fn(async () => undefined);
    const log = { warn: vi.fn() };
    const detach = attachGatewayTurnPerformanceForwarder({
      eventBus,
      gateway: { requestAgentTurnPerformance },
      log,
    });
    const event = buildTurnPerformanceEvent({
      traceId: 'voice-turn-1',
      turnId: 'voice-turn-1',
      requestId: 'voice-turn-1',
      companionId: 'companion-alpha',
      channelId: 'voice-channel-1',
      channelType: 'discord-voice',
      stage: 'speech_end',
      monotonicAtMs: 1_000,
      timestampMs: 2_000,
    });

    await eventBus.emit('agent.turn.performance', event);
    await vi.waitFor(() => {
      expect(requestAgentTurnPerformance).toHaveBeenCalledWith(event);
    });

    detach();
    await eventBus.emit('agent.turn.performance', {
      ...event,
      stage: 'first_audible_playback',
      monotonicAtMs: 1_100,
    });
    expect(requestAgentTurnPerformance).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
