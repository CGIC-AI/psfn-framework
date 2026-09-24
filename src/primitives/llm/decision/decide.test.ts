import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultDecisionBackendSettings,
  type DecisionBackendSettings,
  type DecisionSiteId,
} from '../../../system/config/decision-backend-config.js';
import { buildLLMWorkSpec } from '../work-spec.js';
import { createDecisionRuntime, type RemoteDecisionBackend } from './decide.js';
import type { LocalDecisionBackend } from './local-backend.js';
import type { DecisionShadowRecord } from './shadow-record.js';
import type { DecisionOutcome, DecisionRequest } from './types.js';

const LOCAL_OUTCOME: DecisionOutcome = {
  ok: true,
  answers: { relevant: { type: 'noul', pYes: 0.8 } },
  backend: 'local',
  probabilitySource: 'self_report_uncalibrated',
  latencyMs: 3,
};

const JEV_OUTCOME: DecisionOutcome = {
  ok: true,
  answers: { relevant: { type: 'noul', pYes: 0.2 } },
  backend: 'jev',
  probabilitySource: 'jev',
  latencyMs: 40,
  model: 'typesafe/jev-1.13-20260917',
  costUsd: 0.00002,
};

function makeRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    siteId: 'room.ambiguity',
    state: { message: 'anyone around?' },
    questions: { relevant: { type: 'noul', instructions: 'Is this relevant?' } },
    workSpec: buildLLMWorkSpec({ purpose: 'decision', durable: false }),
    ...overrides,
  };
}

function settingsWith(
  mode: DecisionBackendSettings['mode'],
  sites: DecisionBackendSettings['sites'] = {},
  jev: Partial<DecisionBackendSettings['jev']> = {},
): DecisionBackendSettings {
  const defaults = createDefaultDecisionBackendSettings();
  return { ...defaults, mode, sites, jev: { ...defaults.jev, ...jev } };
}

function rig(settings: DecisionBackendSettings | undefined, jevImpl?: RemoteDecisionBackend['decide']) {
  const local: LocalDecisionBackend = { decide: vi.fn(async () => LOCAL_OUTCOME) };
  const jev = { decide: vi.fn(jevImpl ?? (async () => JEV_OUTCOME)) };
  const records: DecisionShadowRecord[] = [];
  const runtime = createDecisionRuntime({
    local,
    jev,
    resolveSettings: () => settings,
    shadowSink: { record: (entry) => records.push(entry) },
    now: () => 1_000,
  });
  return { runtime, local, jev, records };
}

describe('createDecisionRuntime', () => {
  it('stays local and never calls the remote backend when the block is absent', async () => {
    const { runtime, jev } = rig(undefined);
    await expect(runtime.decide(makeRequest())).resolves.toEqual(LOCAL_OUTCOME);
    expect(jev.decide).not.toHaveBeenCalled();
  });

  it('stays local with the default settings', async () => {
    const { runtime, jev } = rig(createDefaultDecisionBackendSettings());
    await expect(runtime.decide(makeRequest())).resolves.toEqual(LOCAL_OUTCOME);
    expect(jev.decide).not.toHaveBeenCalled();
  });

  it('uses the site local strategy instead of the generic backend', async () => {
    const { runtime, local } = rig(undefined);
    const siteOutcome: DecisionOutcome = { ...LOCAL_OUTCOME, latencyMs: 9 };
    await expect(runtime.decide(makeRequest(), { localStrategy: async () => siteOutcome }))
      .resolves.toBe(siteOutcome);
    expect(local.decide).not.toHaveBeenCalled();
  });

  it('answers from jev in jev mode and sends no work spec or correlation', async () => {
    const { runtime, jev, local } = rig(settingsWith('jev'));
    await expect(runtime.decide(makeRequest())).resolves.toEqual(JEV_OUTCOME);
    expect(local.decide).not.toHaveBeenCalled();
    expect(jev.decide.mock.calls[0]?.[0]).toEqual({
      siteId: 'room.ambiguity',
      state: { message: 'anyone around?' },
      questions: { relevant: { type: 'noul', instructions: 'Is this relevant?' } },
    });
  });

  it('lets a per-site override win over the global mode, both ways', async () => {
    const localSite = rig(settingsWith('jev', { 'room.ambiguity': { mode: 'local' } }));
    await localSite.runtime.decide(makeRequest());
    expect(localSite.jev.decide).not.toHaveBeenCalled();

    const jevSite = rig(settingsWith('local', { 'room.ambiguity': { mode: 'jev' } }));
    await expect(jevSite.runtime.decide(makeRequest())).resolves.toEqual(JEV_OUTCOME);
    expect(jevSite.runtime.effectiveMode('memory.rerank')).toBe('local');
  });

  it.each<[DecisionSiteId, DecisionBackendSettings['mode']]>([
    ['intention.post_turn_pregate', 'jev'],
    ['intention.post_turn_pregate', 'shadow'],
  ])('keeps companion-private site %s local under %s', async (siteId, mode) => {
    const { runtime, jev, records } = rig(settingsWith(mode, { [siteId]: { mode } }));
    await expect(runtime.decide(makeRequest({ siteId }))).resolves.toEqual(LOCAL_OUTCOME);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(jev.decide).not.toHaveBeenCalled();
    expect(records).toEqual([]);
    expect(runtime.effectiveMode(siteId)).toBe('local');
  });

  it('keeps a companion-private correlation local on a shareable site', async () => {
    const { runtime, jev } = rig(settingsWith('jev'));
    await runtime.decide(makeRequest({
      workSpec: buildLLMWorkSpec({
        purpose: 'decision',
        durable: false,
        correlation: { telemetryVisibility: 'companion_private' },
      }),
    }));
    expect(jev.decide).not.toHaveBeenCalled();
  });

  it('falls back to local on a remote failure', async () => {
    const { runtime } = rig(settingsWith('jev'), async () => ({
      ok: false, reason: 'invalid_output', backend: 'jev', latencyMs: 12,
    }));
    await expect(runtime.decide(makeRequest())).resolves.toEqual({ ...LOCAL_OUTCOME, backend: 'local-fallback' });
  });

  it('falls back to local when the remote backend throws', async () => {
    const { runtime } = rig(settingsWith('jev'), async () => {
      throw new Error('network down');
    });
    await expect(runtime.decide(makeRequest())).resolves.toMatchObject({ ok: true, backend: 'local-fallback' });
  });

  it('aborts the remote call at the configured timeout and falls back', async () => {
    let seenSignal: AbortSignal | undefined;
    const { runtime } = rig(settingsWith('jev', {}, { timeoutMs: 50 }), (_request, signal) => {
      seenSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    await expect(runtime.decide(makeRequest())).resolves.toMatchObject({ backend: 'local-fallback' });
    expect(seenSignal?.aborted).toBe(true);
  });

  it('does not send a state larger than the request bound', async () => {
    const { runtime, jev } = rig(settingsWith('jev', {}, { maxRequestChars: 1_000 }));
    const outcome = await runtime.decide(makeRequest({ state: { message: 'x'.repeat(2_000) } }));
    expect(jev.decide).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ backend: 'local-fallback' });
  });

  it('falls back to local when no remote backend is wired', async () => {
    const local: LocalDecisionBackend = { decide: vi.fn(async () => LOCAL_OUTCOME) };
    const runtime = createDecisionRuntime({ local, resolveSettings: () => settingsWith('jev') });
    await expect(runtime.decide(makeRequest())).resolves.toMatchObject({ backend: 'local-fallback' });
  });

  it('acts on local in shadow mode and writes a content-free comparison record', async () => {
    const { runtime, jev, records } = rig(settingsWith('shadow'));
    await expect(runtime.decide(makeRequest())).resolves.toEqual(LOCAL_OUTCOME);
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(jev.decide).toHaveBeenCalledTimes(1);
    expect(records[0]).toEqual({
      schemaVersion: 1,
      recordType: 'decision_shadow_comparison',
      recordedAtMs: 1_000,
      siteId: 'room.ambiguity',
      questions: { relevant: 'noul' },
      local: {
        ok: true,
        answers: { relevant: { type: 'noul', pYes: 0.8 } },
        latencyMs: 3,
        probabilitySource: 'self_report_uncalibrated',
      },
      jev: {
        ok: true,
        answers: { relevant: { type: 'noul', pYes: 0.2 } },
        latencyMs: 40,
        probabilitySource: 'jev',
        model: 'typesafe/jev-1.13-20260917',
        costUsd: 0.00002,
      },
      agreement: { relevant: false },
    });
    expect(JSON.stringify(records[0])).not.toContain('anyone around');
  });

  it('does not delay the shadow caller on a slow remote backend', async () => {
    let release: ((outcome: DecisionOutcome) => void) | undefined;
    const { runtime, records } = rig(settingsWith('shadow'), () => new Promise((resolve) => {
      release = resolve;
    }));
    await expect(runtime.decide(makeRequest())).resolves.toEqual(LOCAL_OUTCOME);
    expect(records).toHaveLength(0);
    release?.(JEV_OUTCOME);
    await vi.waitFor(() => expect(records).toHaveLength(1));
  });

  it('records a failed remote side with null agreement in shadow mode', async () => {
    const { runtime, records } = rig(settingsWith('shadow'), async () => ({
      ok: false, reason: 'error', backend: 'jev', latencyMs: 7,
    }));
    await runtime.decide(makeRequest());
    await vi.waitFor(() => expect(records).toHaveLength(1));
    expect(records[0]?.agreement).toEqual({ relevant: null });
    expect(records[0]?.jev).toEqual({ ok: false, reason: 'error', latencyMs: 7 });
  });
});
