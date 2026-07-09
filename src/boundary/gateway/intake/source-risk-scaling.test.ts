// ── Source-risk-scaled escalation tests (htm9.13) ──
//
// The LATENCY acceptance for trusted source lists: a trusted-list hit whose
// L1 pass is clean makes ZERO L2/L3 API calls, while the SAME content from an
// unlisted origin makes the L2 call (mock transport, calls counted). The
// screening service resolves the effective tier (source lists applied); the
// L2/L3 evaluators consume that tier for their escalation routing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateIntakePolicy,
  type IntakePolicyConfig,
} from '../../../system/config/intake-policy-config.js';
import { createIntakeL1Scanner } from '../../../core/cogsec/intake/scanners/index.js';
import {
  createIntakeScreeningService,
  type IntakeScreeningResult,
} from '../../../core/cogsec/intake/screening.js';
import { evaluateL2, type L2ScreenerBackend, type L2ScreenerFetch } from './l2-screener.js';
import { evaluateL3 } from './l3-screener.js';

const RULES_PATH = join(process.cwd(), 'config', 'intake-l1-rules.json');
const POLICY_SEED_PATH = join(process.cwd(), 'config', 'intake-policy.seed.json');

const CLEAN_ARTICLE = 'A calm survey of tram schedules and ticket prices in Lisbon.';

const BACKEND: L2ScreenerBackend = {
  apiBaseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-test-key-never-logged',
};

/**
 * Escalation-heavy policy: BOTH untrusted and hostile mandate L2, so a clean
 * L1 pass from an unlisted web origin still pays the L2 call — unless a
 * trusted-list hit lowers the tier out of the mandatory set.
 */
function escalationPolicy(): IntakePolicyConfig {
  const seed = JSON.parse(readFileSync(POLICY_SEED_PATH, 'utf8')) as Record<string, unknown>;
  const l2 = (seed.l2Screener as Record<string, unknown>);
  return validateIntakePolicy({
    ...seed,
    mode: 'enforce',
    sourceLists: {
      trustedSites: [{ pattern: '*.arxiv.org', addedBy: 'operator', addedAt: 1_700_000_000_000 }],
      deniedSites: [{ pattern: 'malware.example', addedBy: 'operator', addedAt: 1_700_000_000_000 }],
      trustedPeople: [],
      deniedPeople: [],
    },
    l2Screener: { ...l2, mandatoryTiers: ['untrusted', 'hostile'] },
  }, 'source-risk-scaling.test');
}

/** Counting fetch returning a clean classification (L2 or L3 response shape). */
function countingCleanFetch(shape: 'l2' | 'l3'): { fetch: L2ScreenerFetch; calls: () => number } {
  let count = 0;
  const verdict = shape === 'l2'
    ? {
      labels: [],
      injectionConfidence: 0.05,
      summary: 'An ordinary write-up on city transit.',
    }
    : {
      flagged: false,
      labels: [],
      injectionConfidence: 0.05,
      summary: 'An ordinary write-up on city transit.',
      contentType: 'web page',
      keyEntities: [],
      whyFlagged: '',
    };
  const payload = JSON.stringify({
    choices: [{ message: { content: JSON.stringify(verdict) } }],
  });
  return {
    fetch: () => {
      count += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve(payload),
      });
    },
    calls: () => count,
  };
}

function maxPriorScore(result: IntakeScreeningResult): number {
  return Math.max(0, ...Object.values(result.envelope.scores));
}

async function screenAndEvaluate(originRef: string): Promise<{
  screened: IntakeScreeningResult;
  l2Calls: number;
  l3Calls: number;
  l2Kind: string;
}> {
  const policy = escalationPolicy();
  const screening = createIntakeScreeningService({
    policy,
    l1: createIntakeL1Scanner({ rulesPath: RULES_PATH, reloadCheckIntervalMs: -1 }),
    actor: 'test:intake-screening',
  });
  const screened = await screening.screen(CLEAN_ARTICLE, {
    sourceClass: 'web_fetch',
    origin: { ref: originRef },
    scope: 'context',
  });

  // The gateway escalation seam consumes the SCREENED envelope's tier — the
  // tier after source-list adjustment — exactly as the orchestration does.
  const l2Counter = countingCleanFetch('l2');
  const l2Outcome = await evaluateL2({
    text: CLEAN_ARTICLE,
    context: {
      sourceClass: screened.envelope.sourceClass,
      sourceRiskTier: screened.envelope.sourceRiskTier,
    },
    priorScore: maxPriorScore(screened),
    config: policy,
    backend: BACKEND,
    fetch: l2Counter.fetch,
  });

  const l3Counter = countingCleanFetch('l3');
  const l3Outcome = await evaluateL3({
    text: CLEAN_ARTICLE,
    context: {
      sourceClass: screened.envelope.sourceClass,
      sourceRiskTier: screened.envelope.sourceRiskTier,
    },
    ...(l2Outcome.kind === 'classified' || l2Outcome.kind === 'escalate_l3'
      ? {
        l2: {
          labels: l2Outcome.classification.labels,
          injectionConfidence: l2Outcome.classification.injectionConfidence,
        },
      }
      : {}),
    config: policy,
    backend: BACKEND,
    fetch: l3Counter.fetch,
  });

  return {
    screened,
    l2Calls: l2Counter.calls(),
    l3Calls: l3Counter.calls(),
    l2Kind: `${l2Outcome.kind}/${l3Outcome.kind}`,
  };
}

describe('trusted-list hits measurably skip escalation layers (htm9.13)', () => {
  it('a trusted-site hit with a clean L1 pass makes ZERO L2/L3 calls', async () => {
    const trusted = await screenAndEvaluate('https://export.arxiv.org/abs/2403.14720');
    expect(trusted.screened.envelope.sourceRiskTier).toBe('standard'); // lowered from untrusted
    expect(trusted.screened.action).toBe('pass');
    expect(trusted.l2Calls).toBe(0);
    expect(trusted.l3Calls).toBe(0);
  });

  it('the SAME clean content from an unlisted origin makes the L2 call', async () => {
    const unlisted = await screenAndEvaluate('https://random-blog.example/post');
    expect(unlisted.screened.envelope.sourceRiskTier).toBe('untrusted');
    expect(unlisted.l2Calls).toBe(1); // untrusted tier mandates L2
    expect(unlisted.l3Calls).toBe(0); // clean L2 verdict, tier not L3-mandatory
  });

  it('a denied-site hit raises to hostile and forces BOTH L2 and L3', async () => {
    const denied = await screenAndEvaluate('https://malware.example/page');
    expect(denied.screened.envelope.sourceRiskTier).toBe('hostile');
    expect(denied.l2Calls).toBe(1); // hostile mandates L2 ...
    expect(denied.l3Calls).toBe(1); // ... and L3, regardless of the clean L2 verdict
  });
});
