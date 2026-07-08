import {
  resolveConsolidatedReflectionTemplateId,
  type HeartbeatPolicy,
  type ReflectionTemplate,
} from '../heartbeat-policy.js';
import type { HeartbeatRuntimeOptions } from '../heartbeat-runtime-contracts.js';
import type { DeterministicGateDefinition } from '../../../shared/gating/deterministic-gate.js';
import {
  hasAssertionHeavyIntrospectiveOutput,
  type ReflectionMetacognitiveFlag,
} from './prompt-formatting.js';

const RICH_DELIBERATION_TEMPLATE_IDS = new Set(['daily-review', 'weekly-review']);

// jpvd.4 novelty gate for cadence-fired reflection templates: lane id for the
// typed gate event, watermark processor key, and how many recent session
// entries the deterministic "new entries since last reflection" count scans.
export const REFLECTION_NOVELTY_GATE_LANE = 'reflection.template.novelty';
export const REFLECTION_NOVELTY_WATERMARK_PROCESSOR = 'reflection_template_novelty';
export const REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT = 50;

export type HeartbeatExecutionSource = 'manual' | 'scheduled' | 'deferred_scheduler' | 'deferred_post_turn';

export function getHeartbeatTemplateAuditProfile(
  _template: ReflectionTemplate,
): { allowSilentInterval: boolean } {
  return { allowSilentInterval: false };
}

export class HeartbeatTemplateLoopGuardError extends Error {
  readonly templateId: string;
  readonly source: HeartbeatExecutionSource;
  readonly cooldownUntil: number;

  constructor(
    templateId: string,
    source: HeartbeatExecutionSource,
    cooldownUntil: number,
    message: string,
  ) {
    super(message);
    this.name = 'HeartbeatTemplateLoopGuardError';
    this.templateId = templateId;
    this.source = source;
    this.cooldownUntil = cooldownUntil;
  }
}

export function isHeartbeatTemplateLoopGuardError(
  error: unknown,
): error is HeartbeatTemplateLoopGuardError {
  return error instanceof HeartbeatTemplateLoopGuardError;
}

export function normalizeFiniteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function selectFreshestLiveChatGapMs(...values: Array<number | null | undefined>): number | undefined {
  const finiteValues = values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (finiteValues.length === 0) {
    return undefined;
  }
  return Math.min(...finiteValues);
}

export function isExperientialDeliberationTemplate(template: ReflectionTemplate): boolean {
  return RICH_DELIBERATION_TEMPLATE_IDS.has(template.id);
}

export function buildReflectionNoveltyGateDefinition(minNewEntries: number): DeterministicGateDefinition {
  return {
    lane: REFLECTION_NOVELTY_GATE_LANE,
    openWhenAny: [{
      input: 'newEntriesSinceLastReflection',
      comparator: 'gte',
      threshold: minNewEntries,
    }],
    closedReason: 'insufficient_new_entries',
  };
}

export function findReflectionTemplateById(
  policy: HeartbeatPolicy,
  templateId: string,
): ReflectionTemplate | undefined {
  const consolidatedTemplateId = resolveConsolidatedReflectionTemplateId(templateId);
  return policy.templates.find(candidate => candidate.id === consolidatedTemplateId);
}

export function buildUnsupportedReflectionSupportFlags(
  reflection: string,
  supportProvenanceRefs: readonly string[],
): ReflectionMetacognitiveFlag[] {
  if (supportProvenanceRefs.length > 0 || !hasAssertionHeavyIntrospectiveOutput(reflection)) {
    return [];
  }

  return [{
    flag: 'support_gap_confabulation_risk',
    confidence: 0.82,
    evidence: 'Reflection contains first-person introspective assertions but no persisted grounding provenance refs were available.',
  }];
}

export function resolveCompanionNameFromCharacterVariables(
  provider: HeartbeatRuntimeOptions['characterPromptVariablesProvider'] | undefined,
): string | undefined {
  if (!provider) return undefined;
  const variables = provider();
  for (const key of ['char', 'character_name', 'name', 'character', 'character.name']) {
    const raw = variables[key];
    const candidate = typeof raw === 'string' ? raw.trim() : '';
    if (candidate) return candidate;
  }
  return undefined;
}
