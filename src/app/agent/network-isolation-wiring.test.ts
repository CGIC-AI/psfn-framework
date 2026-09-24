import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { enforceNetworkIsolationOnStartup } from './startup-guards.js';
import { classifyProbeError, proveAgentEgressIsolation } from './network-isolation-probe.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const TARGETS = ['http://192.0.2.1/', 'https://198.51.100.1/', 'http://203.0.113.1/'] as const;

function codedError(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(code), { code }),
  });
}

function timeoutError(): Error {
  return Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
}

type Behavior = { status: number } | { error: Error };

function fakeFetch(behaviors: Record<string, Behavior>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const behavior = behaviors[String(input)];
    if (!behavior) throw new Error(`unexpected probe ${String(input)}`);
    if ('error' in behavior) throw behavior.error;
    return new Response(null, { status: behavior.status });
  }) as typeof fetch;
}

function allTargets(behavior: Behavior): Record<string, Behavior> {
  return Object.fromEntries(TARGETS.map(target => [target, behavior]));
}

const DECLARED = { PSFN_AGENT_EGRESS_ISOLATION: 'kubernetes-network-policy' };

async function verdictFor(env: NodeJS.ProcessEnv, behaviors: Record<string, Behavior>) {
  return proveAgentEgressIsolation({ env, timeoutMs: 50, targets: TARGETS, fetchImpl: fakeFetch(behaviors) });
}

describe('agent egress isolation proof (hrcx5)', () => {
  it('never reports isolated from failed probes alone (timeouts, no launcher evidence)', async () => {
    const verdict = await verdictFor({}, allTargets({ error: timeoutError() }));
    expect(verdict.status).toBe('unknown');
  });

  it('treats selective egress (one target answers) as reachable even with a declaration', async () => {
    const verdict = await verdictFor(DECLARED, {
      ...allTargets({ error: timeoutError() }),
      [TARGETS[2]]: { status: 200 },
    });
    expect(verdict.status).toBe('reachable');
  });

  it('treats a single-target outage as reachable when another target answers', async () => {
    const verdict = await verdictFor(DECLARED, {
      ...allTargets({ status: 204 }),
      [TARGETS[0]]: { error: codedError('ECONNREFUSED') },
    });
    expect(verdict.status).toBe('reachable');
  });

  it('treats an intercepting proxy (block page or TLS peer) as reachable', async () => {
    expect((await verdictFor(DECLARED, {
      ...allTargets({ error: timeoutError() }),
      [TARGETS[0]]: { status: 403 },
    })).status).toBe('reachable');
    expect((await verdictFor(DECLARED, {
      ...allTargets({ error: timeoutError() }),
      [TARGETS[1]]: { error: codedError('ERR_TLS_CERT_ALTNAME_INVALID') },
    })).status).toBe('reachable');
  });

  it('treats DNS and unclassified failures as unknown even with a declaration', async () => {
    expect((await verdictFor(DECLARED, {
      ...allTargets({ error: timeoutError() }),
      [TARGETS[0]]: { error: codedError('ENOTFOUND') },
    })).status).toBe('unknown');
    expect((await verdictFor(DECLARED, {
      ...allTargets({ error: codedError('ENETUNREACH') }),
      [TARGETS[1]]: { error: new Error('something else') },
    })).status).toBe('unknown');
  });

  it('proves isolation only when every target is network-blocked and the launcher declares the mechanism', async () => {
    const verdict = await verdictFor(DECLARED, {
      [TARGETS[0]]: { error: timeoutError() },
      [TARGETS[1]]: { error: codedError('ENETUNREACH') },
      [TARGETS[2]]: { error: codedError('UND_ERR_CONNECT_TIMEOUT') },
    });
    expect(verdict).toMatchObject({ status: 'isolated', mechanism: 'kubernetes-network-policy' });
  });

  it('rejects an unrecognized declaration and a single-target proof', async () => {
    await expect(verdictFor({ PSFN_AGENT_EGRESS_ISOLATION: 'trust-me' }, allTargets({ error: timeoutError() })))
      .rejects.toThrow(/not a recognized isolation mechanism/);
    await expect(proveAgentEgressIsolation({
      env: DECLARED, timeoutMs: 50, targets: [TARGETS[0]], fetchImpl: fakeFetch(allTargets({ status: 200 })),
    })).rejects.toThrow(/at least two/);
  });

  it('classifies a nested timeout cause as blocked', () => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: timeoutError() });
    expect(classifyProbeError('x', error).kind).toBe('blocked');
  });
});

describe('agent startup network isolation enforcement', () => {
  it('is wired into agent startup', () => {
    expect(readFileSync(join(SRC_DIR, 'main.ts'), 'utf-8')).toContain('await enforceNetworkIsolationOnStartup();');
  });

  it('fails closed on reachable and unknown, and starts on proven isolation', async () => {
    await expect(enforceNetworkIsolationOnStartup(DECLARED, {
      targets: TARGETS, fetchImpl: fakeFetch(allTargets({ status: 200 })),
    })).rejects.toThrow(/Outbound network access is reachable/);
    await expect(enforceNetworkIsolationOnStartup({}, {
      targets: TARGETS, fetchImpl: fakeFetch(allTargets({ error: timeoutError() })),
    })).rejects.toThrow(/isolation is unproven/);
    await expect(enforceNetworkIsolationOnStartup(DECLARED, {
      targets: TARGETS, fetchImpl: fakeFetch(allTargets({ error: codedError('EHOSTUNREACH') })),
    })).resolves.toBeUndefined();
  });

  it('honors only the explicit override and never probes under it', async () => {
    const neverFetch = (async () => {
      throw new Error('probe must not run under the override');
    }) as typeof fetch;
    await expect(enforceNetworkIsolationOnStartup(
      { ALLOW_AGENT_OUTBOUND_NETWORK: 'true' },
      { targets: TARGETS, fetchImpl: neverFetch },
    )).resolves.toBeUndefined();
    await expect(enforceNetworkIsolationOnStartup(
      { ALLOW_AGENT_OUTBOUND_NETWORK: 'yes' },
      { targets: TARGETS, fetchImpl: fakeFetch(allTargets({ status: 200 })) },
    )).rejects.toThrow(/reachable/);
  });
});
