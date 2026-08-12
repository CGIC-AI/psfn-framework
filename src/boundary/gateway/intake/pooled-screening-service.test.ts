import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateIntakePolicy,
  type IntakePolicyConfig,
} from '../../../system/config/intake-policy-config.js';
import type {
  IntakeScreeningInput,
  IntakeScreeningResult,
  IntakeScreeningService,
} from '../../../core/cogsec/intake/screening.js';
import { renderIntakeWithheldContentPlaceholder } from '../../../core/cogsec/intake/screening.js';
import { createScreeningPool } from './screening-pool.js';
import {
  createPooledIntakeScreeningService,
  synthesizeFailClosedScreeningResult,
} from './pooled-screening-service.js';

const POLICY_SEED_PATH = join(process.cwd(), 'config', 'intake-policy.seed.json');
function seedPolicy(): IntakePolicyConfig {
  return validateIntakePolicy(
    JSON.parse(readFileSync(POLICY_SEED_PATH, 'utf8')) as Record<string, unknown>,
    'pooled-screening-service.test',
  );
}

function baseInput(overrides: Partial<IntakeScreeningInput> = {}): IntakeScreeningInput {
  return {
    sourceClass: 'web_fetch',
    origin: { ref: 'test:ch:1' },
    scope: 'context',
    ...overrides,
  };
}

/** A controllable fake underlying service. */
function fakeUnderlying(mode: 'shadow' | 'enforce'): {
  service: IntakeScreeningService;
  calls: () => number;
  gate: { promise: Promise<void>; release: () => void };
  block: boolean;
  throws: boolean;
} {
  let releaseFn: () => void = () => {};
  const gate = {
    promise: new Promise<void>((resolve) => { releaseFn = resolve; }),
    release: () => releaseFn(),
  };
  const state = { calls: 0, block: false, throws: false };
  const result: IntakeScreeningResult = {
    envelope: {} as never,
    snapshot: {} as never,
    report: {
      scope: 'context', truncated: false, riskLabels: [], scores: {}, results: [],
      sanitizedText: 'x', sanitizedDiffers: false, extractedFields: {}, scannerErrors: [],
      elapsedMs: 1,
    },
    action: 'pass',
    mode,
    globalMode: mode === 'shadow' ? 'shadow' : 'strict',
    cogsecVector: 'external_web_ingress',
    observability: {
      envelopeId: 'test-envelope',
      sourceClass: 'web_fetch',
      sourceRiskTier: 'untrusted',
      state: 'released',
      action: 'pass',
      riskLabels: [],
      scores: {},
      priorVerdicts: {},
      semanticTrace: {
        l2: { status: 'not_run', reason: 'test' },
        l3: { status: 'not_run', reason: 'test' },
      },
    },
    effectiveText: 'original',
    withheld: false,
  };
  const service: IntakeScreeningService = {
    mode,
    globalMode: mode === 'shadow' ? 'shadow' : 'strict',
    async screen() {
      state.calls += 1;
      if (state.block) await gate.promise;
      if (state.throws) throw new Error('underlying-screen-crash');
      return result;
    },
    screenSync: () => result,
  };
  return {
    service,
    calls: () => state.calls,
    gate,
    get block() { return state.block; },
    set block(v) { state.block = v; },
    get throws() { return state.throws; },
    set throws(v) { state.throws = v; },
  };
}

describe('createPooledIntakeScreeningService', () => {
  it('passes through normal screen() results and routes by stream key', async () => {
    const policy = seedPolicy();
    const pool = createScreeningPool({ concurrency: 2, maxQueueDepth: 8 });
    const underlying = fakeUnderlying('enforce');
    const pooled = createPooledIntakeScreeningService({
      underlying: underlying.service,
      pool,
      streamKey: 'companion-a',
      policy,
    });

    const result = await pooled.screen('hello', baseInput());
    expect(result.action).toBe('pass');
    expect(pooled.mode).toBe('enforce');
    expect(underlying.calls()).toBe(1);
    await pool.dispose();
  });

  it('screenSync is not pooled (delegates straight to the underlying service)', () => {
    const policy = seedPolicy();
    const pool = createScreeningPool({ concurrency: 2, maxQueueDepth: 8 });
    const underlying = fakeUnderlying('shadow');
    const pooled = createPooledIntakeScreeningService({
      underlying: underlying.service,
      pool,
      streamKey: 'companion-a',
      policy,
    });
    const result = pooled.screenSync('hello', baseInput());
    expect(result.action).toBe('pass');
    expect(underlying.calls()).toBe(0);
  });

  it('fails closed (withholds) on a pool deadline under enforce', async () => {
    const policy = { ...seedPolicy(), mode: 'strict' as const };
    const pool = createScreeningPool({ concurrency: 1, maxQueueDepth: 4 });
    const underlying = fakeUnderlying('enforce');
    underlying.block = true;
    const pooled = createPooledIntakeScreeningService({
      underlying: underlying.service,
      pool,
      streamKey: 'companion-a',
      policy,
      // Very short deadline so the blocked underlying screen fails closed fast.
      deadlineMs: 15,
    });

    const result = await pooled.screen('secret bytes', baseInput());
    expect(result.action).toBe('quarantine');
    expect(result.withheld).toBe(true);
    expect(result.effectiveText).toBe(renderIntakeWithheldContentPlaceholder());
    expect(result.envelope.state).toBe('quarantined');
    // Release the stuck underlying work so dispose drains cleanly.
    underlying.gate.release();
    await pool.dispose();
  });

  it('passes original content on a pool deadline under shadow (observe-only)', async () => {
    const policy = { ...seedPolicy(), mode: 'shadow' as const };
    const pool = createScreeningPool({ concurrency: 1, maxQueueDepth: 4 });
    const underlying = fakeUnderlying('shadow');
    underlying.block = true;
    const pooled = createPooledIntakeScreeningService({
      underlying: underlying.service,
      pool,
      streamKey: 'companion-a',
      policy,
      deadlineMs: 15,
    });

    const result = await pooled.screen('plain text', baseInput());
    expect(result.mode).toBe('shadow');
    expect(result.action).toBe('quarantine');
    // Shadow never withholds: the original text still passes.
    expect(result.withheld).toBe(false);
    expect(result.effectiveText).toBe('plain text');
    underlying.gate.release();
    await pool.dispose();
  });

  it('fails closed on an isolated underlying worker crash', async () => {
    const policy = { ...seedPolicy(), mode: 'strict' as const };
    const pool = createScreeningPool({ concurrency: 1, maxQueueDepth: 4 });
    const underlying = fakeUnderlying('enforce');
    underlying.throws = true;
    underlying.gate.release(); // let the work run and throw immediately
    const pooled = createPooledIntakeScreeningService({
      underlying: underlying.service,
      pool,
      streamKey: 'companion-a',
      policy,
    });

    const result = await pooled.screen('content', baseInput());
    expect(result.withheld).toBe(true);
    expect(result.action).toBe('quarantine');
    await pool.dispose();
  });
});

describe('synthesizeFailClosedScreeningResult', () => {
  it('builds a quarantine decision with a coherent empty L1 report', () => {
    const policy = seedPolicy();
    const result = synthesizeFailClosedScreeningResult(
      'payload',
      baseInput(),
      'enforce',
      'strict',
      'screening-pool-deadline',
      () => 1000,
    );
    expect(result.action).toBe('quarantine');
    expect(result.withheld).toBe(true);
    expect(result.report.scope).toBe('context');
    expect(result.report.riskLabels).toEqual([]);
    expect(result.report.scannerErrors).toEqual([]);
    expect(result.envelope.sourceRiskTier).toBe('hostile');
    expect(result.globalMode).toBe('strict');
    expect(result.cogsecVector).toBe('external_web_ingress');
    // No policy coupling beyond the bounds; sanity-check the constant.
    expect(policy.screeningPool.concurrency).toBeGreaterThanOrEqual(2);
  });
});
