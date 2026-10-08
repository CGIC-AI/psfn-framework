import { describe, expect, it } from 'vitest';
import { assertTurnEvidence, projectEvent } from './evidence.mjs';

const message = 'Synthetic request';
const reply = 'Synthetic reply';
const turn = { turnId: 'turn-1', requestId: 'request-1', status: 'completed',
  userMessage: { content: message }, assistantMessage: { content: reply },
  observability: { stages: [{ stage: 'first-token' }] } };
const events = ['provider_request', 'provider_complete', 'turn_complete'].map(stage => ({
  type: 'agent.turn.performance', stage, requestId: 'request-1', turnId: 'turn-1',
}));

describe('portable full-runtime evidence', () => {
  it('rejects missing or mismatched durable outcomes and absent trace stages', () => {
    const input = { turn, events, message, reply };
    expect(assertTurnEvidence(input)).toMatchObject({ turnId: 'turn-1', requestId: 'request-1' });
    expect(() => assertTurnEvidence({ ...input, turn: undefined })).toThrow('Persisted turn missing');
    expect(() => assertTurnEvidence({ ...input, reply: 'fabricated' })).toThrow('differs');
    for (let i = 0; i < events.length; i += 1) {
      expect(() => assertTurnEvidence({ ...input, events: events.filter((_, n) => n !== i) })).toThrow('Missing correlated');
    }
    expect(() => assertTurnEvidence({ ...input, events: events.map(event => ({ ...event, requestId: 'unrelated' })) })).toThrow('Missing correlated');
    expect(() => assertTurnEvidence({ ...input, events: events.map(event => ({ ...event, turnId: 'unrelated' })) })).toThrow('mixes turns');
  });

  it('exports IDs and timing while discarding payloads, arguments and synthetic credentials', () => {
    const projected = projectEvent({ type: 'agent.tool.end', data: {
      requestId: 'request-1', turnId: 'turn-1', toolCallId: 'call-1', outcome: 'executed',
      args: { token: 'synthetic-secret' }, result: 'private body', error: 'Bearer synthetic-secret',
      prompt: 'private prompt', durationMs: 12,
    } });
    expect(projected).toEqual({ type: 'agent.tool.end', requestId: 'request-1', turnId: 'turn-1', toolCallId: 'call-1', outcome: 'executed', durationMs: 12 });
    expect(JSON.stringify(projected)).not.toMatch(/private|synthetic-secret/u);
    expect(projectEvent({ type: 'agent.turn.snapshot', data: { snapshot: 'private prompt' } })).toBeNull();
  });
});
