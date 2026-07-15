import { describe, expect, it, vi } from 'vitest';
import { createSignalWisePostTurnAppraiser } from './post-turn-appraisal.js';

describe('createSignalWisePostTurnAppraiser', () => {
  it('deduplicates explicit dedupe keys across signal passes with first-wins ordering', async () => {
    const appraise = createSignalWisePostTurnAppraiser<{ channelId: string }>([
      {
        name: 'first',
        infer: () => [{
          kind: 'heartbeat.run_template',
          dedupeKey: 'heartbeat.run_template:musing',
          payload: { templateId: 'musing' },
        }],
      },
      {
        name: 'second',
        infer: () => [{
          kind: 'heartbeat.run_template',
          dedupeKey: 'heartbeat.run_template:musing',
          payload: { templateId: 'shadowed' },
        }, {
          kind: 'custom.follow_up',
          dedupeKey: 'custom.follow_up:msg-1',
          payload: { topic: 'diagnostics' },
        }],
      },
    ]);

    const inferred = await appraise({ channelId: 'api:test' });

    expect(inferred).toEqual([{
      kind: 'heartbeat.run_template',
      dedupeKey: 'heartbeat.run_template:musing',
      payload: { templateId: 'musing' },
    }, {
      kind: 'custom.follow_up',
      dedupeKey: 'custom.follow_up:msg-1',
      payload: { topic: 'diagnostics' },
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
          payload: { templateId: 'musing' },
        }],
      },
    ], { onPassError });

    const inferred = await appraise({ channelId: 'api:test' });

    expect(inferred).toEqual([{
      kind: 'heartbeat.run_template',
      payload: { templateId: 'musing' },
    }]);
    expect(onPassError).toHaveBeenCalledWith(
      'failing',
      expect.any(Error),
      { channelId: 'api:test' },
    );
  });
});
