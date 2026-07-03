import { describe, expect, it, vi } from 'vitest';
import { FallbackRunner, NonRecoverableFallbackError } from './fallback.js';
import type { RoutingCandidate } from './routing.js';

const chatPrimary: RoutingCandidate = {
  model: 'primary/model',
  provider: 'openrouter',
  maxTokens: 4096,
};

const chatFallback: RoutingCandidate = {
  model: 'fallback/model',
  provider: 'openrouter',
  maxTokens: 4096,
};

describe('FallbackRunner', () => {
  it('falls back to the next candidate after retryable failure', async () => {
    const runner = new FallbackRunner({ rateLimitCooldownMs: 1000, now: () => 0 });
    const seen: string[] = [];

    const result = await runner.run(
      'chat',
      [chatPrimary, chatFallback],
      async (candidate) => {
        seen.push(candidate.model);
        if (candidate.model === chatPrimary.model) {
          throw new Error('timeout');
        }
        return `ok:${candidate.model}`;
      },
    );

    expect(seen).toEqual([chatPrimary.model, chatFallback.model]);
    expect(result.attempts).toBe(2);
    expect(result.candidate.model).toBe(chatFallback.model);
    expect(result.result).toBe(`ok:${chatFallback.model}`);
  });

  it('cooldowns rate-limited candidates and defers them on subsequent runs', async () => {
    let now = 0;
    const runner = new FallbackRunner({ rateLimitCooldownMs: 1000, now: () => now });

    const firstRunSeen: string[] = [];
    await runner.run(
      'chat',
      [chatPrimary, chatFallback],
      async (candidate) => {
        firstRunSeen.push(candidate.model);
        if (candidate.model === chatPrimary.model) {
          throw new Error('429 rate limit');
        }
        return 'ok';
      },
    );
    expect(firstRunSeen).toEqual([chatPrimary.model, chatFallback.model]);

    const secondRunSeen: string[] = [];
    await runner.run(
      'chat',
      [chatPrimary, chatFallback],
      async (candidate) => {
        secondRunSeen.push(candidate.model);
        return 'ok';
      },
    );
    expect(secondRunSeen[0]).toBe(chatFallback.model);

    now = 2_000;
    const thirdRunSeen: string[] = [];
    await runner.run(
      'chat',
      [chatPrimary, chatFallback],
      async (candidate) => {
        thirdRunSeen.push(candidate.model);
        return 'ok';
      },
    );
    expect(thirdRunSeen[0]).toBe(chatPrimary.model);
  });

  it('cooldowns unreachable candidates and defers them on subsequent runs', async () => {
    let now = 0;
    const runner = new FallbackRunner({ rateLimitCooldownMs: 1000, now: () => now });

    const firstRunSeen: string[] = [];
    await runner.run(
      'chat',
      [chatPrimary, chatFallback],
      async (candidate) => {
        firstRunSeen.push(candidate.model);
        if (candidate.model === chatPrimary.model) {
          throw new Error(
            '500 litellm.InternalServerError: OpenAIException - Connection error. '
            + 'Cannot connect to host 192.168.1.43:8000 ssl:default',
          );
        }
        return 'ok';
      },
    );
    expect(firstRunSeen).toEqual([chatPrimary.model, chatFallback.model]);

    const secondRunSeen: string[] = [];
    await runner.run(
      'chat',
      [chatPrimary, chatFallback],
      async (candidate) => {
        secondRunSeen.push(candidate.model);
        return 'ok';
      },
    );
    expect(secondRunSeen[0]).toBe(chatFallback.model);

    now = 2_000;
    const thirdRunSeen: string[] = [];
    await runner.run(
      'chat',
      [chatPrimary, chatFallback],
      async (candidate) => {
        thirdRunSeen.push(candidate.model);
        return 'ok';
      },
    );
    expect(thirdRunSeen[0]).toBe(chatPrimary.model);
  });

  it('fails fast for context overflow without trying next candidate', async () => {
    const runner = new FallbackRunner({ rateLimitCooldownMs: 1000, now: () => 0 });
    const execute = vi.fn(async (_candidate: RoutingCandidate) => {
      throw new Error('maximum context length exceeded');
    });

    await expect(
      runner.run('chat', [chatPrimary, chatFallback], execute),
    ).rejects.toThrow(/context length|maximum context length/);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('streams through the next candidate after a pre-output failure', async () => {
    const runner = new FallbackRunner({ rateLimitCooldownMs: 1000, now: () => 0 });
    const seen: string[] = [];
    const events: string[] = [];

    for await (const event of runner.runStream(
      'chat',
      [chatPrimary, chatFallback],
      (candidate) => (async function* execute() {
        seen.push(candidate.model);
        if (candidate.model === chatPrimary.model) {
          throw new Error('503 upstream unavailable');
        }
        yield `ok:${candidate.model}`;
      })(),
    )) {
      events.push(event);
    }

    expect(seen).toEqual([chatPrimary.model, chatFallback.model]);
    expect(events).toEqual([`ok:${chatFallback.model}`]);
  });

  it('stops stream fallback when a candidate failure is explicitly non-recoverable', async () => {
    const runner = new FallbackRunner({ rateLimitCooldownMs: 1000, now: () => 0 });
    const seen: string[] = [];

    await expect((async () => {
      for await (const _event of runner.runStream(
        'chat',
        [chatPrimary, chatFallback],
        (candidate) => (async function* execute() {
          seen.push(candidate.model);
          throw new NonRecoverableFallbackError(new Error('stream already committed'));
        })(),
      )) {
        // no-op
      }
    })()).rejects.toThrow(/stream already committed/);

    expect(seen).toEqual([chatPrimary.model]);
  });
});
