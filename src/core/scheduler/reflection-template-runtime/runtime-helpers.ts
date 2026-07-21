import {
  resolveConsolidatedReflectionTemplateId,
  type ReflectionPolicy,
  type ReflectionTemplate,
} from '../reflection-policy.js';
import type { ReflectionRuntimeOptions } from '../reflection-runtime-contracts.js';
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

export type ReflectionExecutionSource = 'manual' | 'scheduled' | 'deferred_scheduler' | 'deferred_post_turn';

export function getReflectionTemplateAuditProfile(
  _template: ReflectionTemplate,
): { allowSilentInterval: boolean } {
  return { allowSilentInterval: false };
}

export class ReflectionTemplateLoopGuardError extends Error {
  readonly templateId: string;
  readonly source: ReflectionExecutionSource;
  readonly cooldownUntil: number;

  constructor(
    templateId: string,
    source: ReflectionExecutionSource,
    cooldownUntil: number,
    message: string,
  ) {
    super(message);
    this.name = 'ReflectionTemplateLoopGuardError';
    this.templateId = templateId;
    this.source = source;
    this.cooldownUntil = cooldownUntil;
  }
}

export function isReflectionTemplateLoopGuardError(
  error: unknown,
): error is ReflectionTemplateLoopGuardError {
  return error instanceof ReflectionTemplateLoopGuardError;
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
  policy: ReflectionPolicy,
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
  provider: ReflectionRuntimeOptions['characterPromptVariablesProvider'] | undefined,
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
