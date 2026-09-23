import { describe, expect, it } from 'vitest';
import { buildApiHealthResponse } from './server-health.js';
import type { ApiServerHealthChecks } from './types.js';

function checksWithLlm(llm: ApiServerHealthChecks['llm']): ApiServerHealthChecks {
  return {
    memory: () => ({ status: 'healthy' }),
    llm,
    discord: () => ({ status: 'healthy' }),
    embeddings: () => ({ status: 'healthy' }),
    scheduler: () => ({ status: 'healthy' }),
  };
}

async function gatewayLinkFor(llm: ApiServerHealthChecks['llm']) {
  const { body } = await buildApiHealthResponse({
    healthChecks: checksWithLlm(llm),
    lastSchedulerHealthcheckAtMs: Date.now(),
    schedulerHealthcheckStaleAfterMs: 60_000,
  });
  return body.continuity.checks.gatewayLink;
}

describe('buildApiHealthResponse gatewayLink continuity', () => {
  it('stays healthy when discovery failed behind a gateway that answered', async () => {
    await expect(gatewayLinkFor(() => ({
      status: 'degraded',
      detail: 'models API returned 503',
      meta: { gatewayReachable: true },
    }))).resolves.toMatchObject({
      status: 'healthy',
      meta: { gatewayReachable: true, llmStatus: 'degraded' },
    });
  });

  it('degrades when the llm check has no gateway reachability evidence', async () => {
    await expect(gatewayLinkFor(() => ({
      status: 'degraded',
      detail: 'Gateway connection closed',
      meta: { gatewayReachable: false },
    }))).resolves.toMatchObject({
      status: 'degraded',
      detail: 'Gateway connection closed',
      meta: { gatewayReachable: false },
    });
  });
});
