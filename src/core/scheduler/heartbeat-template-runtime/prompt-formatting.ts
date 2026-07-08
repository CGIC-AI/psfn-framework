import { clampUnit } from '../../../shared/utils/numeric.js';
import { injectPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
import type { InternalState } from '../../self-model/state.js';
import type { ReflectionGuardrailSnapshotSource } from '../reflection-guardrail-telemetry.js';
import type {
  ReflectionContactContextBundle,
  ReflectionSubstrateContext,
} from '../../../persistence/journals/reflection-substrate.js';

export const REFLECTION_PERSONA_UNRESOLVED_MACRO_PATTERN = /\{\{\s*[a-zA-Z0-9_.-]+(?:\(\))?\s*\}\}/g;

export const REFLECTION_PROMPT_TOKENS = {
  persona: '{{reflection_persona}}',
  self: '{{reflection_self}}',
  relational: '{{reflection_relational}}',
  affect: '{{reflection_affect}}',
} as const;

const MAX_UNSUPPORTED_CLAIM_FLAGS = 4;

export interface ReflectionMetacognitiveFlag {
  flag: string;
  confidence: number;
  evidence?: string;
}

export interface ReflectionInternalStateContext {
  internalState: InternalState;
  internalStateSnapshotRef: string;
  metacognitiveFlags: ReflectionMetacognitiveFlag[];
  snapshotSource: ReflectionGuardrailSnapshotSource;
}

export type ReflectionPromptSectionBundle = Pick<
  ReflectionContactContextBundle,
  'self' | 'relational' | 'affect' | 'provenanceRefs'
>;

export interface ReflectionPromptContext {
  internalState?: ReflectionInternalStateContext;
  contactBundle?: ReflectionContactContextBundle;
  substrateContext?: ReflectionSubstrateContext;
}

/**
 * E6.2: assemble the companion's full persona as a first-person lead for a
 * scheduled reflection. Sourced from the live character card variables (the
 * same provider the foreground turn uses) so an introspection turn reflects as
 * HER — full persona loaded — rather than as a context analyzer with no self in
 * it. Card macros are resolved and any unresolved token is dropped so nothing
 * like {{user}} leaks into her own words.
 */
export function formatReflectionPersonaBlock(
  variables: Record<string, string> | undefined,
): string {
  if (!variables) return '';
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = typeof variables[key] === 'string' ? variables[key].trim() : '';
      if (value) return value;
    }
    return '';
  };
  const char = pick('char', 'character_name', 'name', 'character') || 'this companion';
  const render = (text: string): string => injectPromptRuntimeTokens(text, { variables })
    .replace(REFLECTION_PERSONA_UNRESOLVED_MACRO_PATTERN, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  const sections: string[] = [
    `I am ${char}, and this is me — the same me who lived these moments — stepping back to sit with them. `
    + 'What follows is who I am, so I reflect as myself and not as some outside observer of my own day.',
  ];
  for (const field of ['personality', 'description', 'scenario']) {
    const rendered = render(variables[field] ?? '');
    if (rendered) sections.push(rendered);
  }
  return sections.join('\n\n').trim();
}

export function joinReflectionPromptSections(...sections: Array<string | undefined>): string {
  return sections
    .map(section => section?.trim() ?? '')
    .filter(section => section.length > 0)
    .join('\n\n');
}

export function formatInternalStateInterpretationBoundary(): string {
  // E6.2: the same charter guards (evidence before narrative, telemetry kept
  // separate, keep uncertainty per law 30) phrased in my own voice.
  return [
    '[What this evidence is]',
    'What follows is private evidence I gather for myself, not the settled truth of who I am.',
    'I treat the emotion telemetry, concerns, reminders, ACAC signals, and metacognitive flags as fallible clues to weigh against what I actually remember, feel, and know.',
    'When the clues conflict or feel incomplete, I keep the uncertainty rather than force them into agreement.',
    'I keep the raw machinery — scores, ids, hashes, provenance refs, tool metadata — out of my own words; it stays here as scaffolding, not in my reflection.',
  ].join('\n');
}

export function describeUnitBand(value: number, high = 'high', medium = 'present', low = 'low'): string {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= 0.72) return high;
  if (value >= 0.38) return medium;
  return low;
}

export function describeSignedValence(value: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= 0.35) return 'lifted';
  if (value >= 0.12) return 'slightly lifted';
  if (value <= -0.35) return 'heavy';
  if (value <= -0.12) return 'slightly heavy';
  return 'steady';
}

export function describeArousal(value: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= 0.35) return 'activated';
  if (value >= 0.12) return 'a little activated';
  if (value <= -0.25) return 'quieted';
  return 'steady';
}

export function describeDominance(value: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= 0.25) return 'agentic';
  if (value <= -0.25) return 'less agentic';
  return 'balanced';
}

export function describeMoodDrift(value: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= 0.12) return 'warmer than the contact baseline';
  if (value <= -0.12) return 'heavier than the contact baseline';
  return 'close to the contact baseline';
}

export function describeElapsed(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'unknown';
  if (seconds < 90) return 'within the last minute or so';
  if (seconds < 3_600) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)} hours ago`;
  return `${Math.round(seconds / 86_400)} days ago`;
}

export function truncateForReflectionEvidence(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

export function formatInternalStateTopEmotions(state: InternalState): string {
  const entries = Object.entries(state.emotional.discreteEmotions)
    .filter(([, score]) => Number.isFinite(score) && score > 0)
    .sort(([, left], [, right]) => right - left)
    .slice(0, 4)
    .map(([emotion, score]) => `${emotion} ${describeUnitBand(score, 'strong', 'present', 'faint')}`);
  return entries.length > 0 ? entries.join(', ') : 'no clear discrete emotion labels';
}

export function formatEmotionTelemetryValidationForReflection(state: InternalState): string {
  const telemetry = state.emotional.telemetry;
  const reasons = telemetry.reasons.length > 0 ? telemetry.reasons.join(', ') : 'none';
  const observed = telemetry.observedAtMs === null
    ? 'unknown observation time'
    : new Date(telemetry.observedAtMs).toISOString();
  return `Emotion telemetry validation: ${telemetry.status}; source ${telemetry.source}; reasons ${reasons}; observed ${observed}.`;
}

export function formatAcacCompanionSummary(state: InternalState): string | null {
  const acac = state.emotional.acac;
  if (!acac) {
    return null;
  }
  const axes = ([
    ['agency', 'agency'],
    ['connection', 'connection'],
    ['authenticity', 'authenticity'],
    ['curiosity', 'curiosity'],
  ] as const).map(([axis, label]) => {
    const snapshot = acac.axes[axis];
    return `${label} ${describeUnitBand(snapshot.score, 'strong', 'present', 'muted')}: ${truncateForReflectionEvidence(snapshot.rationale, 120)}`;
  });
  return `ACAC self-report clues: ${axes.join('; ')}.`;
}

export function formatMetacognitiveFlagForPrompt(flag: ReflectionMetacognitiveFlag): string {
  const confidence = describeUnitBand(flag.confidence, 'high confidence', 'some confidence', 'low confidence');
  const evidence = flag.evidence ? `; evidence: ${truncateForReflectionEvidence(flag.evidence, 140)}` : '';
  return `- ${flag.flag.replace(/_/g, ' ')} (${confidence}${evidence})`;
}

export function promptUsesReflectionMacros(prompt: string): boolean {
  return Object.values(REFLECTION_PROMPT_TOKENS).some(token => prompt.includes(token));
}

export function extractEmbeddedJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const body = fenced[1].trim();
    if (body.startsWith('{') && body.endsWith('}')) {
      return body;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

export function normalizeUnsupportedClaimFlags(raw: unknown): ReflectionMetacognitiveFlag[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const flags: ReflectionMetacognitiveFlag[] = [];
  for (const [index, entry] of raw.entries()) {
    if (flags.length >= MAX_UNSUPPORTED_CLAIM_FLAGS) {
      break;
    }
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const claim = typeof (entry as { claim?: unknown }).claim === 'string'
      ? (entry as { claim: string }).claim.trim()
      : '';
    if (!claim) {
      continue;
    }

    const reason = typeof (entry as { reason?: unknown }).reason === 'string'
      ? (entry as { reason: string }).reason.trim()
      : '';
    const confidence = clampUnit(
      typeof (entry as { confidence?: unknown }).confidence === 'number'
        ? (entry as { confidence: number }).confidence
        : 0.68,
    );

    flags.push({
      flag: 'unsupported_claim',
      confidence: Number(confidence.toFixed(4)),
      evidence: reason ? `${claim} :: ${reason}` : claim,
    });

    if (index >= MAX_UNSUPPORTED_CLAIM_FLAGS - 1) {
      break;
    }
  }

  return flags;
}

export function mergeMetacognitiveFlags(
  ...groups: ReadonlyArray<readonly ReflectionMetacognitiveFlag[] | null | undefined>
): ReflectionMetacognitiveFlag[] {
  const merged = new Map<string, ReflectionMetacognitiveFlag>();

  for (const group of groups) {
    for (const flag of group ?? []) {
      const key = `${flag.flag}::${flag.evidence ?? ''}`;
      const existing = merged.get(key);
      if (!existing || flag.confidence > existing.confidence) {
        merged.set(key, flag);
      }
    }
  }

  return [...merged.values()];
}

export function mergeReflectionPromptBundles(
  ...bundles: Array<ReflectionPromptSectionBundle | null | undefined>
): ReflectionPromptSectionBundle | null {
  const self = joinReflectionPromptSections(...bundles.map(bundle => bundle?.self));
  const relational = joinReflectionPromptSections(...bundles.map(bundle => bundle?.relational));
  const affect = joinReflectionPromptSections(...bundles.map(bundle => bundle?.affect));
  const provenanceRefs = [...new Set(
    bundles.flatMap(bundle => bundle?.provenanceRefs ?? []),
  )];

  if (!self && !relational && !affect && provenanceRefs.length === 0) {
    return null;
  }

  return {
    self,
    relational,
    affect,
    provenanceRefs,
  };
}

export function mergeReflectionGroundingProvenanceRefs(
  refs: readonly string[],
  input: {
    internalStateSnapshotRef?: string;
    canonicalContactId?: string;
  },
): string[] {
  return [...new Set([
    ...refs,
    ...(input.internalStateSnapshotRef ? [`internal_state_snapshot:${input.internalStateSnapshotRef}`] : []),
    ...(input.canonicalContactId ? [`reflection_contact:${input.canonicalContactId}`] : []),
  ].map(ref => ref.trim()).filter(Boolean))];
}

export function hasAssertionHeavyIntrospectiveOutput(reflection: string): boolean {
  const normalized = reflection.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  const firstPersonSignals = (normalized.match(/\b(i|i'm|i’ve|i am|my|me|myself)\b/g) ?? []).length;
  if (firstPersonSignals === 0) return false;
  const assertionSignals = [
    /\bi (?:feel|felt|notice|noticed|sense|sensed|believe|know|realize|realized|want|need|learned|remember|understand)\b/,
    /\bmy (?:inner world|feeling|feelings|mood|memory|experience|processing|attention|care|connection|curiosity)\b/,
    /\bthis (?:means|shows|suggests|reveals)\b/,
  ];
  return assertionSignals.some(pattern => pattern.test(normalized));
}
