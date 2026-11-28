import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import {
  COMPANION_TOOL_ACTIVITY_PHASES,
  type CompanionEventEnvelope,
} from '../../../shared/contracts/companion-relay.js';
import { TOOL_CALL_OUTCOMES } from '../../../shared/contracts/tool-call-outcome.js';
import { TOOL_ACTIVITY_PHASES as HUB_TOOL_ACTIVITY_PHASES } from '../../../../apps/satellite-hub/src/ts/shared/protocol.js';
import { parseCompanionEventData } from '../../../../apps/satellite-hub/src/ts/hub/companion-bridge.js';
import { attachCompanionEventForwarder } from './agent-forwarder.js';
import {
  CompanionEventRelay,
  parseCompanionRelayPublishParams,
  type CompanionRelayPublishParams,
} from './relay.js';

// psfn-framework-ik47b.15: the Hub project cannot import framework source, so
// it mirrors the relay's tool-activity phase list. These tests pin the mirror
// and drive every agent-emitted phase through the real agent forwarder, the
// gateway RPC validator, the gateway relay and the Hub SSE parser.

const COMPANION_ID = 'contract-companion';

describe('companion relay -> Satellite Hub tool-activity contract', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('Hub phase list is identical to the framework relay phase list', () => {
    expect([...HUB_TOOL_ACTIVITY_PHASES]).toEqual([...COMPANION_TOOL_ACTIVITY_PHASES]);
  });

  it('Hub accepts every phase the agent emits, end to end', async () => {
    const agentBus = new EventBus();
    const gatewayBus = new EventBus();
    const published: CompanionRelayPublishParams[] = [];
    cleanups.push(attachCompanionEventForwarder({
      eventBus: agentBus,
      publisher: { publishCompanionEvent: (params) => published.push(params) },
    }));
    const relay = new CompanionEventRelay({ eventBus: gatewayBus, defaultCompanionId: COMPANION_ID });
    cleanups.push(() => relay.stop());
    const streamed: string[] = [];
    relay.subscribe({
      companionId: COMPANION_ID,
      allowedKinds: ['tool.activity'],
      // The SSE route serializes tool.activity envelopes unchanged.
      onEvent: (envelope: CompanionEventEnvelope) => streamed.push(JSON.stringify(envelope)),
    });

    await agentBus.emit('agent.tool.start', { toolCallId: 'call-start', toolName: 'web_search' });
    for (const outcome of TOOL_CALL_OUTCOMES) {
      await agentBus.emit('agent.tool.end', {
        toolCallId: `call-${outcome}`,
        toolName: 'web_search',
        outcome,
        isError: outcome !== 'success' && outcome !== 'partial_result',
      });
    }

    for (const params of published) {
      const parsed = parseCompanionRelayPublishParams(params);
      expect(parsed.kind).toBe('tool.activity');
      if (parsed.kind !== 'tool.activity') continue;
      await gatewayBus.emit('companion.tool.activity', { payload: parsed.payload, timestamp: Date.now() });
    }

    const hubEvents = streamed.map((data) => parseCompanionEventData(data));
    const agentPhases = published.map((params) => (params.payload as { phase: string }).phase);
    expect(hubEvents).toHaveLength(TOOL_CALL_OUTCOMES.length + 1);
    expect(hubEvents.map((event) => event.kind === 'tool.activity' ? event.payload.phase : null))
      .toEqual(agentPhases);
    // Every phase the agent can project reaches the Hub, including the
    // previously dropped rejected and skipped phases.
    expect(new Set(agentPhases)).toEqual(
      new Set(['started', 'completed', 'failed', 'rejected', 'skipped']),
    );
  });

  it.each(COMPANION_TOOL_ACTIVITY_PHASES)('Hub parser accepts relay phase %s', (phase) => {
    const event = parseCompanionEventData(JSON.stringify({
      kind: 'tool.activity',
      payload: { id: 'act-1', tool: 'web_search', phase, timestamp: '2026-07-09T00:00:00.000Z' },
      emittedAt: '2026-07-09T00:00:00.000Z',
    }));
    expect(event).toEqual({
      kind: 'tool.activity',
      payload: { id: 'act-1', tool: 'web_search', phase, timestamp: '2026-07-09T00:00:00.000Z' },
    });
  });
});
