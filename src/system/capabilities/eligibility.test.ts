import { describe, expect, it } from 'vitest';
import type { CapabilityTier } from '../../types.js';
import type { CapabilityToken } from './tokens.js';
import {
  createEligibilityGate,
  evaluateEligibilityDecision,
  type EligibilityOperation,
} from './eligibility.js';
import type { CapabilityAccess } from './access.js';
import { resolveTierCapabilityTokens } from './tiers.js';

function accessForTier(
  tier: CapabilityTier,
  customTokens: CapabilityToken[] = [],
): CapabilityAccess {
  const granted = new Set(resolveTierCapabilityTokens(tier, customTokens));
  return {
    getTier: () => tier,
    getGrantedTokens: () => granted,
    has: (token) => granted.has(token),
  };
}

describe('EligibilityGate', () => {
  it('fails closed for unknown llm purposes', () => {
    const gate = createEligibilityGate(() => accessForTier('autonomous'));
    const decision = gate.evaluate({ kind: 'llm.purpose', purpose: 'totally_unknown' });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('unsupported_operation');
  });

  it('enforces default background purpose requirements', () => {
    const decision = evaluateEligibilityDecision(
      accessForTier('custom', ['identity.read']),
      { kind: 'llm.purpose', purpose: 'background' },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('missing_capability_tokens');
    expect(decision.missingTokens).toEqual(['memory.write']);
  });

  it('enforces minimum tier when configured', () => {
    const operation: EligibilityOperation = {
      kind: 'scheduler.task',
      taskId: 'task-1',
      taskName: 'Task 1',
      taskType: 'every',
    };
    const decision = evaluateEligibilityDecision(
      accessForTier('nursery'),
      operation,
      { minimumTier: 'apprentice' },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('tier_below_minimum');
    expect(decision.minimumTier).toBe('apprentice');
  });

  it('allows tool execution when required tokens are granted', () => {
    const decision = evaluateEligibilityDecision(
      accessForTier('apprentice'),
      { kind: 'tool.execute', toolName: 'memory_write' },
      { requiredTokens: ['memory.write'] },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe('allowed');
  });

  it('fails closed for plugin activation without explicit eligibility requirements', () => {
    const decision = evaluateEligibilityDecision(
      accessForTier('autonomous'),
      { kind: 'plugin.activate', pluginType: 'stt', pluginId: 'plugin-test' },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('unsupported_operation');
  });

  it('enforces explicit eligibility requirements for plugin actions', () => {
    const decision = evaluateEligibilityDecision(
      accessForTier('nursery'),
      { kind: 'plugin.action', pluginType: 'tts', pluginId: 'plugin-test', action: 'synthesize_stream' },
      { requiredTokens: ['external.web'] },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('missing_capability_tokens');
    expect(decision.missingTokens).toEqual(['external.web']);
  });
});
