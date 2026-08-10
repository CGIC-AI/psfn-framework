import { describe, expect, it, vi } from 'vitest';
import type {
  CompletionPurpose,
  CorrelationMetadata,
  LLMContext,
  LLMResponse,
} from '../../shared/contracts/runtime.js';
import { COMPANION_PRIVATE_BACKGROUND_PURPOSE } from '../../shared/contracts/runtime.js';
import {
  resolveRuntimeLaneClassForModelCall,
  type ModelCallRuntimePurpose,
} from '../../core/agent/worker-lanes.js';
import {
  RUNTIME_LANE_CLASSES,
  type RuntimeLaneClass,
} from '../../shared/contracts/runtime-lanes.js';
import { COMPANION_PRIVATE_BACKGROUND_TELEMETRY } from '../../shared/telemetry/model-usage.js';
import { resolveCorrelationMetadata } from './correlation.js';
import {
  assertWorkSpecLaneParity,
  buildLLMWorkSpec,
  completeWithWorkSpec,
} from './work-spec.js';

// Independent replica of LLMClient.toRoutingPurpose + resolveModelCallRuntimeClass
// (the admission gate lane path). Deliberately NOT importing model-call-lane, so
// this is a true cross-check that a declared LLMWorkSpec.lane reconciles
// byte-identically with the client's gate resolution (Law 12.4).
function gateReplicaRoutingPurpose(purpose: CompletionPurpose): ModelCallRuntimePurpose {
  if (purpose === 'reasoning') return 'reasoning';
  if (purpose === 'import_processing') return 'import_processing';
  if (purpose === 'memory') return 'memory';
  if (purpose === 'context') return 'context';
  if (purpose === 'extraction') return 'extraction';
  if (purpose === 'summary') return 'summary';
  if (purpose === 'vision') return 'vision';
  return 'background';
}

function gateReplicaLane(
  purpose: CompletionPurpose,
  correlation: Partial<CorrelationMetadata> | undefined,
): RuntimeLaneClass {
  const resolved = resolveCorrelationMetadata(correlation, undefined, purpose);
  const routingPurpose = gateReplicaRoutingPurpose(purpose);
  // resolveCorrelationMetadata always sets callType (mirrors the client gate,
  // whose `?? inferCallType` fallback is therefore never taken).
  return resolveRuntimeLaneClassForModelCall({
    purpose: routingPurpose,
    callType: resolved.callType,
    ...(resolved.channelId ? { channelId: resolved.channelId } : {}),
    ...(resolved.originStage ? { originStage: resolved.originStage } : {}),
  });
}

interface CallSiteFixture {
  name: string;
  purpose: CompletionPurpose;
  correlation?: Partial<CorrelationMetadata>;
  expectedLane: RuntimeLaneClass;
}

// One fixture per current autonomous call site, carrying the exact purpose +
// correlation that site passes today, plus its hand-verified lane.
const CALL_SITES: CallSiteFixture[] = [
  {
    name: 'emotion.appraisal',
    purpose: 'background',
    correlation: {
      purpose: 'emotion.appraisal',
      callType: 'background',
      originType: 'background',
      originStage: 'emotion.appraisal',
      channelId: 'session-1',
    },
    expectedLane: RUNTIME_LANE_CLASSES.backgroundContinuation,
  },
  {
    name: 'intention.appraisal.evaluator',
    purpose: 'background',
    correlation: {
      requestId: 'appraisal:1',
      callType: 'background',
      purpose: 'agent.intention.appraisal',
      originType: 'background',
      originStage: 'agent.intention.appraisal',
      channelId: 'session-1',
    },
    expectedLane: RUNTIME_LANE_CLASSES.backgroundContinuation,
  },
  {
    name: 'intention.concern_candidate_review',
    purpose: 'background',
    correlation: {
      requestId: 'concern-candidate-review:a,b',
      callType: 'background',
      purpose: 'intention.concern_candidate_review',
      originType: 'background',
      originStage: 'intention.concern_candidate_review',
      channelId: 'ch-1',
    },
    expectedLane: RUNTIME_LANE_CLASSES.backgroundContinuation,
  },
  {
    name: 'intention.nudge_evaluation (no correlation)',
    purpose: 'background',
    expectedLane: RUNTIME_LANE_CLASSES.backgroundContinuation,
  },
  {
    name: 'icp.initiation_consent',
    purpose: 'background',
    correlation: {
      requestId: 'icp-consent:x',
      channelId: 'internal:icp-consent:x',
      callType: 'background',
      purpose: 'agent.intention.appraisal',
    },
    expectedLane: RUNTIME_LANE_CLASSES.backgroundContinuation,
  },
  {
    name: 'introspection.* (companion-private)',
    purpose: 'background',
    correlation: COMPANION_PRIVATE_BACKGROUND_TELEMETRY,
    expectedLane: RUNTIME_LANE_CLASSES.backgroundContinuation,
  },
  {
    name: 'memory.sleeptime.plan',
    purpose: 'memory',
    correlation: {
      requestId: 'sleeptime:s:a',
      channelId: 'ch-1',
      callType: 'memory',
      purpose: 'memory.sleeptime.plan',
      originType: 'memory',
      originStage: 'memory.sleeptime.plan',
    },
    expectedLane: RUNTIME_LANE_CLASSES.maintenanceReflection,
  },
  {
    name: 'memory.sleeptime.wiki',
    purpose: 'memory',
    correlation: {
      requestId: 'wiki-pass:s:1',
      channelId: 's',
      callType: 'memory',
      purpose: 'memory.sleeptime.plan',
      originType: 'memory',
      originStage: 'memory.sleeptime.wiki',
    },
    expectedLane: RUNTIME_LANE_CLASSES.maintenanceReflection,
  },
  {
    name: 'context.feedback',
    purpose: 'memory',
    correlation: {
      requestId: 'ctx',
      turnId: 't1',
      channelId: 'ch-1',
      callType: 'memory',
      originType: 'memory',
      originStage: 'context.feedback',
      purpose: 'context.feedback',
    },
    expectedLane: RUNTIME_LANE_CLASSES.maintenanceReflection,
  },
  {
    name: 'memory.episodic.judgment',
    purpose: 'memory',
    correlation: {
      requestId: 'episodic:1',
      channelId: 'ch-1',
      callType: 'memory',
      purpose: 'memory.episodic.judgment',
      originStage: 'memory.episodic.judgment',
    },
    expectedLane: RUNTIME_LANE_CLASSES.maintenanceReflection,
  },
  {
    name: 'memory.profile_synthesis',
    purpose: 'memory',
    correlation: {
      requestId: 'recent-contact-shape-synthesis:c:1',
      channelId: 'ch-1',
      callType: 'memory',
      purpose: 'memory.profile_synthesis',
    },
    expectedLane: RUNTIME_LANE_CLASSES.maintenanceReflection,
  },
  {
    name: 'memory.extraction',
    purpose: 'extraction',
    correlation: {
      requestId: 'extract:1',
      channelId: 'ch-1',
      callType: 'memory',
      purpose: 'memory.extraction',
    },
    expectedLane: RUNTIME_LANE_CLASSES.maintenanceReflection,
  },
  {
    name: 'session.compression_guideline.update',
    purpose: 'context',
    correlation: {
      requestId: 'compression-guideline-update:ch:1',
      channelId: 'ch-1',
      callType: 'background',
      purpose: 'session.compression_guideline.update',
      originType: 'background',
      originStage: 'session.compression_guideline.update',
    },
    expectedLane: RUNTIME_LANE_CLASSES.backgroundContinuation,
  },
  {
    name: 'session.compaction.summary',
    purpose: 'background',
    correlation: {
      requestId: 'compaction:summary',
      channelId: 'ch-1',
      callType: 'summary',
      purpose: 'session.compaction.summary',
      originType: 'summary',
      originStage: 'session.compaction.summary',
    },
    expectedLane: RUNTIME_LANE_CLASSES.postTurnAppraisal,
  },
  {
    name: 'focus.complete.summary (tool)',
    purpose: 'context',
    correlation: {
      requestId: 'focus:1',
      channelId: 'ch-1',
      callType: 'tool',
      purpose: 'focus.complete.summary',
      originType: 'tool',
      originStage: 'focus.complete.summary',
    },
    expectedLane: RUNTIME_LANE_CLASSES.foregroundChat,
  },
  {
    name: 'analysis_workbench.iteration (tool)',
    purpose: 'reasoning',
    correlation: {
      requestId: 'iteration-1',
      channelId: 'ch-1',
      callType: 'tool',
      purpose: 'repl.analysis_workbench.iteration',
      originType: 'tool',
      originStage: 'repl.analysis_workbench.iteration',
    },
    expectedLane: RUNTIME_LANE_CLASSES.foregroundChat,
  },
  {
    name: 'analysis_workbench.sandbox_proxy (tool, dynamic purpose)',
    purpose: 'reasoning',
    correlation: {
      requestId: 'sandbox-1',
      channelId: 'ch-1',
      callType: 'tool',
      purpose: 'repl.sandbox.reasoning',
      originType: 'tool',
      originStage: 'repl.sandbox.reasoning',
    },
    expectedLane: RUNTIME_LANE_CLASSES.foregroundChat,
  },
  {
    name: 'api.health_probe (no correlation)',
    purpose: 'reasoning',
    expectedLane: RUNTIME_LANE_CLASSES.foregroundChat,
  },
];

describe('LLMWorkSpec lane parity (Law 12.4)', () => {
  it.each(CALL_SITES)(
    'derives a lane that reconciles with the gate resolver for $name',
    ({ purpose, correlation, expectedLane }) => {
      const spec = buildLLMWorkSpec({ purpose, durable: false, ...(correlation ? { correlation } : {}) });
      // spec.lane matches the hand-verified expectation ...
      expect(spec.lane).toBe(expectedLane);
      // ... and is byte-identical to an independent replica of the client gate.
      expect(spec.lane).toBe(gateReplicaLane(purpose, correlation));
      // ... and passes the fail-closed parity assertion.
      expect(() => assertWorkSpecLaneParity(spec)).not.toThrow();
    },
  );

  it('rejects a hand-tampered lane (fail closed)', () => {
    const spec = buildLLMWorkSpec({ purpose: 'memory', durable: true, correlation: { callType: 'memory' } });
    const tampered = { ...spec, lane: RUNTIME_LANE_CLASSES.foregroundChat };
    expect(() => assertWorkSpecLaneParity(tampered)).toThrow(/does not reconcile/);
  });
});

describe('completeWithWorkSpec entry', () => {
  function captureProvider() {
    const calls: Array<{ context: LLMContext; purpose: CompletionPurpose; options: unknown }> = [];
    const provider = {
      complete: vi.fn(async (context: LLMContext, purpose: CompletionPurpose, options: unknown): Promise<LLMResponse> => {
        calls.push({ context, purpose, options });
        return {
          content: 'ok',
          providerObservability: undefined as never,
          toolCalls: [],
          model: 'test',
          inputTokens: 1,
          outputTokens: 1,
          usageDetails: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          stopReason: 'stop',
        } as unknown as LLMResponse;
      }),
    };
    return { provider, calls };
  }

  it('forwards purpose, work spec, and correlation to the underlying complete', async () => {
    const { provider, calls } = captureProvider();
    const spec = buildLLMWorkSpec({
      purpose: 'memory',
      durable: true,
      correlation: { callType: 'memory', purpose: 'memory.extraction' },
    });
    await completeWithWorkSpec(provider, { systemPrompt: 's', messages: [] }, spec);
    expect(calls).toHaveLength(1);
    expect(calls[0].purpose).toBe('memory');
    const options = calls[0].options as { workSpec?: unknown; correlation?: unknown };
    expect(options.workSpec).toBe(spec);
    expect(options.correlation).toEqual({ callType: 'memory', purpose: 'memory.extraction' });
  });

  it('preserves the companion-private correlation collapse end to end', () => {
    // The client resolves this correlation; assert the collapse the client relies
    // on is intact (companion_private -> background purpose, no channelId).
    const resolved = resolveCorrelationMetadata(COMPANION_PRIVATE_BACKGROUND_TELEMETRY, undefined, 'background');
    expect(resolved.telemetryVisibility).toBe('companion_private');
    expect(resolved.purpose).toBe(COMPANION_PRIVATE_BACKGROUND_PURPOSE);
    expect(resolved.originStage).toBe(COMPANION_PRIVATE_BACKGROUND_PURPOSE);
    expect(resolved.channelId).toBeUndefined();
    // And the work spec derived from it forwards the same correlation reference.
    const spec = buildLLMWorkSpec({
      purpose: 'background',
      durable: false,
      correlation: COMPANION_PRIVATE_BACKGROUND_TELEMETRY,
    });
    expect(spec.correlation).toBe(COMPANION_PRIVATE_BACKGROUND_TELEMETRY);
    expect(spec.lane).toBe(RUNTIME_LANE_CLASSES.backgroundContinuation);
  });

  it('keeps ICP conversation field-agreement enforcement at the client (unbroken)', () => {
    const icpCorrelation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      localCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      peerCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      peerContactId: 'contact-a',
      channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082',
      messageId: 'message-1',
      requestId: 'request-1',
      chargeLane: 'companion_social' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'reply' as const,
      fatigueDecision: 'allow' as const,
    };
    const conflicting: Partial<CorrelationMetadata> = {
      callType: 'background',
      purpose: 'agent.intention.appraisal',
      conversationId: '55555555-5555-4555-8555-555555555555',
      icpCorrelation,
    };
    // The client's resolver still enforces field-agreement (unbroken).
    expect(() => resolveCorrelationMetadata(conflicting, undefined, 'background'))
      .toThrow(/ICP.*conversationId/i);
    // Lane derivation must NOT double that validation: it derives a lane from
    // the raw fields without running (or pre-empting) ICP validation, so the
    // client remains the single place ICP correlations are validated.
    expect(() => buildLLMWorkSpec({ purpose: 'background', durable: false, correlation: conflicting }))
      .not.toThrow();
  });
});
