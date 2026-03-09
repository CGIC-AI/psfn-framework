import { describe, expect, it, vi } from 'vitest';
import { createSignalWisePostTurnAppraiser } from './post-turn-appraisal.js';

describe('createSignalWisePostTurnAppraiser', () => {
  it('deduplicates explicit dedupe keys across signal passes with first-wins ordering', async () => {
    const appraise = createSignalWisePostTurnAppraiser<{ channelId: string }>([
      {
        name: 'first',
        infer: () => [{
          kind: 'heartbeat.run_template',
          dedupeKey: 'heartbeat.run_template:whisper',
          payload: { templateId: 'whisper' },
        }],
      },
      {
        name: 'second',
        infer: () => [{
          kind: 'heartbeat.run_template',
          dedupeKey: 'heartbeat.run_template:whisper',
          payload: { templateId: 'shadowed' },
        }, {
          kind: 'tool_handoff.continue',
          dedupeKey: 'tool_handoff.continue:msg-1',
          payload: { toolNames: ['extended_probe_tool'] },
        }],
      },
    ]);

    const inferred = await appraise({ channelId: 'api:test' });

    expect(inferred).toEqual([{
      kind: 'heartbeat.run_template',
      dedupeKey: 'heartbeat.run_template:whisper',
      payload: { templateId: 'whisper' },
    }, {
      kind: 'tool_handoff.continue',
      dedupeKey: 'tool_handoff.continue:msg-1',
      payload: { toolNames: ['extended_probe_tool'] },
    }]);
  });

  it('continues past failing signal passes', async () => {
    const onPassError = vi.fn();
    const appraise = createSignalWisePostTurnAppraiser<{ channelId: string }>([
      {
        name: 'failing',
        infer: () => {
          throw new Error('boom');
        },
      },
      {
        name: 'healthy',
        infer: () => [{
          kind: 'heartbeat.run_template',
          payload: { templateId: 'whisper' },
        }],
      },
    ], { onPassError });

    const inferred = await appraise({ channelId: 'api:test' });

    expect(inferred).toEqual([{
      kind: 'heartbeat.run_template',
      payload: { templateId: 'whisper' },
    }]);
    expect(onPassError).toHaveBeenCalledWith(
      'failing',
      expect.any(Error),
      { channelId: 'api:test' },
    );
  });
});
