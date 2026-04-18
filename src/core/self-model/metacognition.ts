import { cloneInternalState, type InternalState } from './state.js';
import { wrapPromptSectionXml } from '../identity/prompt-sections.js';

export const METACOGNITIVE_FLAG_NAMES = [
  'uncertainty',
  'avoidance',
  'high_engagement',
  'repetition',
  'confabulation_risk',
] as const;

export type MetacognitiveFlagName = typeof METACOGNITIVE_FLAG_NAMES[number];

export interface MetacognitiveFlag {
  flag: MetacognitiveFlagName;
  confidence: number;
  evidence: string;
}

export interface MetacognitiveMonitorInput {
  internalState: InternalState;
  recentResponses: readonly string[];
  latestResponse: string;
  toolCallCount: number;
  contradictoryMemorySignalCount: number;
  supportingMemoryCount: number;
}

export interface MetacognitiveMonitorConfig {
  uncertaintyCertaintyThreshold: number;
  uncertaintyContradictionSignalThreshold: number;
  avoidanceLookbackTurns: number;
  avoidanceConcernCoverageThreshold: number;
  highEngagementArousalThreshold: number;
  highEngagementValenceThreshold: number;
  highEngagementToolCallThreshold: number;
  repetitionLookbackTurns: number;
  repetitionJaccardThreshold: number;
  confabulationMinAssertionCount: number;
}

export interface MetacognitiveNotesFormatOptions {
  minConfidence?: number;
  maxFlags?: number;
}

interface ResolvedMetacognitiveMonitorConfig extends MetacognitiveMonitorConfig {}

interface NormalizedMetacognitiveInput {
  internalState: InternalState;
  recentResponses: string[];
  latestResponse: string;
  toolCallCount: number;
  contradictoryMemorySignalCount: number;
  supportingMemoryCount: number;
}

const DEFAULT_MONITOR_CONFIG: ResolvedMetacognitiveMonitorConfig = Object.freeze({
  uncertaintyCertaintyThreshold: 0.4,
  uncertaintyContradictionSignalThreshold: 1,
  avoidanceLookbackTurns: 3,
  avoidanceConcernCoverageThreshold: 0.34,
  highEngagementArousalThreshold: 0.7,
  highEngagementValenceThreshold: 0.1,
  highEngagementToolCallThreshold: 2,
  repetitionLookbackTurns: 4,
  repetitionJaccardThreshold: 0.75,
  confabulationMinAssertionCount: 1,
});

const TOKEN_PATTERN = /[a-z0-9][a-z0-9'_-]*/g;
const ASSERTIVE_VERB_PATTERN = /\b(is|are|was|were|will|must|should|cannot|can't|can|did|does|do|has|have|had|means|indicates|shows|proves|confirms|requires)\b/i;
const HEDGING_PATTERN = /\b(maybe|might|possibly|perhaps|i think|i guess|i am not sure|i'm not sure|uncertain)\b/i;
const TOKEN_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'their',
  'them',
  'there',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
]);

export class MetacognitiveMonitor {
  private readonly config: ResolvedMetacognitiveMonitorConfig;

  constructor(config: Partial<MetacognitiveMonitorConfig> = {}) {
    this.config = resolveMetacognitiveMonitorConfig(config);
  }

  detectFlags(input: MetacognitiveMonitorInput): MetacognitiveFlag[] {
    const normalized = normalizeMonitorInput(input);
    const detectors = [
      detectUncertaintyFlag,
      detectAvoidanceFlag,
      detectHighEngagementFlag,
      detectRepetitionFlag,
      detectConfabulationRiskFlag,
    ] as const;

    const detected = detectors
      .map(detector => detector(normalized, this.config))
      .filter((flag): flag is MetacognitiveFlag => flag !== null);
    return cloneMetacognitiveFlags(detected);
  }
}

export function cloneMetacognitiveFlags(flags: readonly MetacognitiveFlag[]): MetacognitiveFlag[] {
  if (!Array.isArray(flags)) {
    throw new Error('Metacognitive flags must be an array');
  }
  return flags
    .map((flag, index) => normalizeMetacognitiveFlag(flag, index))
    .sort((left, right) => METACOGNITIVE_FLAG_NAMES.indexOf(left.flag) - METACOGNITIVE_FLAG_NAMES.indexOf(right.flag));
}

export function serializeMetacognitiveFlags(flags: readonly MetacognitiveFlag[]): string {
  return JSON.stringify(cloneMetacognitiveFlags(flags));
}

export function buildMetacognitiveFlagPromptVariables(
  flags: readonly MetacognitiveFlag[] = [],
): Record<string, string> {
  const variables = Object.fromEntries(
    METACOGNITIVE_FLAG_NAMES.flatMap(flagName => [
      [`runtime_flag_${flagName}_present`, 'false'],
      [`runtime_flag_${flagName}_confidence`, ''],
      [`runtime_flag_${flagName}_evidence`, ''],
    ]),
  ) as Record<string, string>;

  for (const flag of cloneMetacognitiveFlags(flags)) {
    variables[`runtime_flag_${flag.flag}_present`] = 'true';
    variables[`runtime_flag_${flag.flag}_confidence`] = flag.confidence.toFixed(3);
    variables[`runtime_flag_${flag.flag}_evidence`] = flag.evidence;
  }

  return variables;
}

export function formatMetacognitiveNotesContextBlock(
  flags: readonly MetacognitiveFlag[],
  options: MetacognitiveNotesFormatOptions = {},
): string {
  const normalizedFlags = cloneMetacognitiveFlags(flags);
  const minConfidence = options.minConfidence === undefined
    ? 0.35
    : parseUnit(options.minConfidence, 'minConfidence');
  const maxFlags = options.maxFlags === undefined
    ? 3
    : parsePositiveInteger(options.maxFlags, 'maxFlags');
  const selected = normalizedFlags
    .filter(flag => flag.confidence >= minConfidence)
    .slice(0, maxFlags);
  if (selected.length === 0) return '';

  const lines: string[] = [];
  for (const flag of selected) {
    lines.push(`- ${flag.flag} (confidence=${flag.confidence.toFixed(3)}): ${flag.evidence}`);
  }
  return wrapPromptSectionXml({
    id: 'metacognitive_notes',
    content: lines.join('\n'),
  });
}

export function buildMetacognitivePersonaHint(flags: readonly MetacognitiveFlag[]): string | null {
  const normalizedFlags = cloneMetacognitiveFlags(flags);
  const guidance: string[] = [];
  const uncertainty = normalizedFlags.find(flag => flag.flag === 'uncertainty' && flag.confidence >= 0.45);
  if (uncertainty) {
    guidance.push('Use tentative language and acknowledge uncertainty explicitly.');
  }
  const confabulationRisk = normalizedFlags.find(
    flag => flag.flag === 'confabulation_risk' && flag.confidence >= 0.45,
  );
  if (confabulationRisk) {
    guidance.push('Anchor strong claims to retrieved evidence, or state when evidence is missing.');
  }
  if (guidance.length === 0) return null;

  return wrapPromptSectionXml({
    id: 'metacognitive_persona_guidance',
    content: guidance.map(entry => `- ${entry}`).join('\n'),
  });
}

function detectUncertaintyFlag(
  input: NormalizedMetacognitiveInput,
  config: ResolvedMetacognitiveMonitorConfig,
): MetacognitiveFlag | null {
  const certainty = input.internalState.cognitive.certaintyLevel;
  const certaintySignal = certainty < config.uncertaintyCertaintyThreshold
    ? clampUnit((config.uncertaintyCertaintyThreshold - certainty) / Math.max(config.uncertaintyCertaintyThreshold, Number.EPSILON))
    : 0;
  const contradictionSignal = input.contradictoryMemorySignalCount >= config.uncertaintyContradictionSignalThreshold
    ? clampUnit(input.contradictoryMemorySignalCount / (config.uncertaintyContradictionSignalThreshold + 2))
    : 0;
  if (certaintySignal === 0 && contradictionSignal === 0) {
    return null;
  }
  const confidence = roundDecimal(
    clampUnit(Math.max(0.05, (certaintySignal * 0.6) + (contradictionSignal * 0.4))),
  );
  const evidenceParts = [
    `certainty=${certainty.toFixed(3)} (<${config.uncertaintyCertaintyThreshold.toFixed(3)})`,
    `contradictory_memory_signals=${input.contradictoryMemorySignalCount}`,
  ];
  return buildMetacognitiveFlag('uncertainty', confidence, evidenceParts.join('; '));
}

function detectAvoidanceFlag(
  input: NormalizedMetacognitiveInput,
  config: ResolvedMetacognitiveMonitorConfig,
): MetacognitiveFlag | null {
  const lookback = input.recentResponses.slice(-config.avoidanceLookbackTurns);
  if (lookback.length === 0 || input.internalState.attention.activeConcerns.length === 0) {
    return null;
  }
  const responseTokens = lookback.map(text => tokenizeSignalTerms(text));
  let consideredConcernCount = 0;
  const unresolvedConcernIds: string[] = [];

  for (const concern of input.internalState.attention.activeConcerns) {
    const concernTokens = tokenizeSignalTerms(concern.text);
    if (concernTokens.size === 0) continue;
    consideredConcernCount += 1;
    const addressed = responseTokens.some(tokens => tokenCoverage(concernTokens, tokens) >= config.avoidanceConcernCoverageThreshold);
    if (!addressed) {
      unresolvedConcernIds.push(concern.id);
    }
  }

  if (consideredConcernCount === 0 || unresolvedConcernIds.length === 0) {
    return null;
  }
  const confidence = roundDecimal(clampUnit(unresolvedConcernIds.length / consideredConcernCount));
  const evidence = `unresolved_concerns=${unresolvedConcernIds.join(',')}; lookback_turns=${lookback.length}`;
  return buildMetacognitiveFlag('avoidance', confidence, evidence);
}

function detectHighEngagementFlag(
  input: NormalizedMetacognitiveInput,
  config: ResolvedMetacognitiveMonitorConfig,
): MetacognitiveFlag | null {
  const arousal = input.internalState.emotional.vad.arousal;
  const blendedValence = roundDecimal(
    (input.internalState.emotional.vad.valence + input.internalState.emotional.mood.valence) / 2,
  );
  if (
    arousal <= config.highEngagementArousalThreshold
    || blendedValence <= config.highEngagementValenceThreshold
    || input.toolCallCount <= config.highEngagementToolCallThreshold
  ) {
    return null;
  }

  const arousalSignal = clampUnit(
    (arousal - config.highEngagementArousalThreshold) / Math.max(1 - config.highEngagementArousalThreshold, Number.EPSILON),
  );
  const valenceSignal = clampUnit(
    (blendedValence - config.highEngagementValenceThreshold) / Math.max(1 - config.highEngagementValenceThreshold, Number.EPSILON),
  );
  const toolSignal = clampUnit(
    (input.toolCallCount - config.highEngagementToolCallThreshold) / (config.highEngagementToolCallThreshold + 1),
  );
  const confidence = roundDecimal(clampUnit((arousalSignal * 0.4) + (valenceSignal * 0.35) + (toolSignal * 0.25)));
  const evidence = `arousal=${arousal.toFixed(3)}; valence=${blendedValence.toFixed(3)}; tool_calls=${input.toolCallCount}`;
  return buildMetacognitiveFlag('high_engagement', confidence, evidence);
}

function detectRepetitionFlag(
  input: NormalizedMetacognitiveInput,
  config: ResolvedMetacognitiveMonitorConfig,
): MetacognitiveFlag | null {
  const history = [
    ...input.recentResponses.slice(-config.repetitionLookbackTurns),
    input.latestResponse,
  ].filter(value => value.length > 0);
  if (history.length < 2) return null;

  const tokenSets = history.map(text => tokenizeSignalTerms(text));
  let maxSimilarity = 0;
  for (let i = 0; i < tokenSets.length; i += 1) {
    for (let j = i + 1; j < tokenSets.length; j += 1) {
      maxSimilarity = Math.max(maxSimilarity, jaccardSimilarity(tokenSets[i], tokenSets[j]));
    }
  }
  if (maxSimilarity <= config.repetitionJaccardThreshold) return null;

  const confidence = roundDecimal(
    clampUnit((maxSimilarity - config.repetitionJaccardThreshold) / Math.max(1 - config.repetitionJaccardThreshold, Number.EPSILON)),
  );
  const evidence = `max_jaccard=${maxSimilarity.toFixed(3)}; sampled_responses=${history.length}`;
  return buildMetacognitiveFlag('repetition', confidence, evidence);
}

function detectConfabulationRiskFlag(
  input: NormalizedMetacognitiveInput,
  config: ResolvedMetacognitiveMonitorConfig,
): MetacognitiveFlag | null {
  const assertionCount = countAssertionSentences(input.latestResponse);
  if (
    assertionCount < config.confabulationMinAssertionCount
    || input.supportingMemoryCount > 0
  ) {
    return null;
  }
  const confidence = roundDecimal(clampUnit(0.35 + (Math.min(assertionCount, 4) * 0.15)));
  const evidence = `assertions=${assertionCount}; supporting_memories=${input.supportingMemoryCount}`;
  return buildMetacognitiveFlag('confabulation_risk', confidence, evidence);
}

function normalizeMonitorInput(input: MetacognitiveMonitorInput): NormalizedMetacognitiveInput {
  if (!isRecord(input)) {
    throw new Error('MetacognitiveMonitor input must be an object');
  }
  return {
    internalState: cloneInternalState(input.internalState),
    recentResponses: normalizeTextList(input.recentResponses, 'recentResponses'),
    latestResponse: normalizeText(input.latestResponse, 'latestResponse'),
    toolCallCount: parseNonNegativeFinite(input.toolCallCount, 'toolCallCount'),
    contradictoryMemorySignalCount: parseNonNegativeInteger(
      input.contradictoryMemorySignalCount,
      'contradictoryMemorySignalCount',
    ),
    supportingMemoryCount: parseNonNegativeInteger(input.supportingMemoryCount, 'supportingMemoryCount'),
  };
}

function resolveMetacognitiveMonitorConfig(
  config: Partial<MetacognitiveMonitorConfig>,
): ResolvedMetacognitiveMonitorConfig {
  if (!isRecord(config)) {
    throw new Error('Metacognitive monitor config must be an object');
  }
  return {
    uncertaintyCertaintyThreshold: parseUnit(
      config.uncertaintyCertaintyThreshold ?? DEFAULT_MONITOR_CONFIG.uncertaintyCertaintyThreshold,
      'uncertaintyCertaintyThreshold',
    ),
    uncertaintyContradictionSignalThreshold: parsePositiveInteger(
      config.uncertaintyContradictionSignalThreshold ?? DEFAULT_MONITOR_CONFIG.uncertaintyContradictionSignalThreshold,
      'uncertaintyContradictionSignalThreshold',
    ),
    avoidanceLookbackTurns: parsePositiveInteger(
      config.avoidanceLookbackTurns ?? DEFAULT_MONITOR_CONFIG.avoidanceLookbackTurns,
      'avoidanceLookbackTurns',
    ),
    avoidanceConcernCoverageThreshold: parseUnit(
      config.avoidanceConcernCoverageThreshold ?? DEFAULT_MONITOR_CONFIG.avoidanceConcernCoverageThreshold,
      'avoidanceConcernCoverageThreshold',
    ),
    highEngagementArousalThreshold: parseUnit(
      config.highEngagementArousalThreshold ?? DEFAULT_MONITOR_CONFIG.highEngagementArousalThreshold,
      'highEngagementArousalThreshold',
    ),
    highEngagementValenceThreshold: parseSignedUnit(
      config.highEngagementValenceThreshold ?? DEFAULT_MONITOR_CONFIG.highEngagementValenceThreshold,
      'highEngagementValenceThreshold',
    ),
    highEngagementToolCallThreshold: parsePositiveInteger(
      config.highEngagementToolCallThreshold ?? DEFAULT_MONITOR_CONFIG.highEngagementToolCallThreshold,
      'highEngagementToolCallThreshold',
    ),
    repetitionLookbackTurns: parsePositiveInteger(
      config.repetitionLookbackTurns ?? DEFAULT_MONITOR_CONFIG.repetitionLookbackTurns,
      'repetitionLookbackTurns',
    ),
    repetitionJaccardThreshold: parseUnit(
      config.repetitionJaccardThreshold ?? DEFAULT_MONITOR_CONFIG.repetitionJaccardThreshold,
      'repetitionJaccardThreshold',
    ),
    confabulationMinAssertionCount: parsePositiveInteger(
      config.confabulationMinAssertionCount ?? DEFAULT_MONITOR_CONFIG.confabulationMinAssertionCount,
      'confabulationMinAssertionCount',
    ),
  };
}

function buildMetacognitiveFlag(
  flag: MetacognitiveFlagName,
  confidence: number,
  evidence: string,
): MetacognitiveFlag {
  return normalizeMetacognitiveFlag({ flag, confidence, evidence });
}

function normalizeMetacognitiveFlag(flag: MetacognitiveFlag, index?: number): MetacognitiveFlag {
  if (!isRecord(flag)) {
    throw new Error('Metacognitive flag must be an object');
  }
  if (!METACOGNITIVE_FLAG_NAMES.includes(flag.flag)) {
    throw new Error(`Metacognitive flag${index === undefined ? '' : ` at index ${String(index)}`} has unsupported name "${String(flag.flag)}"`);
  }
  const confidence = parseUnit(flag.confidence, `flags${index === undefined ? '' : `[${String(index)}]`}.confidence`);
  const evidence = normalizeNonEmptyText(
    flag.evidence,
    `flags${index === undefined ? '' : `[${String(index)}]`}.evidence`,
  );
  return {
    flag: flag.flag,
    confidence,
    evidence,
  };
}

function countAssertionSentences(text: string): number {
  if (!text) return 0;
  const sentences = text
    .split(/[.!?\n]+/g)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0);
  let assertionCount = 0;
  for (const sentence of sentences) {
    if (!ASSERTIVE_VERB_PATTERN.test(sentence)) continue;
    if (HEDGING_PATTERN.test(sentence)) continue;
    assertionCount += 1;
  }
  return assertionCount;
}

function tokenizeSignalTerms(text: string): Set<string> {
  const tokens = new Set<string>();
  const matches = text.toLowerCase().match(TOKEN_PATTERN);
  if (!matches) return tokens;
  for (const token of matches) {
    if (token.length < 3 || TOKEN_STOP_WORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function tokenCoverage(source: Set<string>, target: Set<string>): number {
  if (source.size === 0 || target.size === 0) return 0;
  let overlap = 0;
  for (const token of source) {
    if (target.has(token)) {
      overlap += 1;
    }
  }
  return overlap / source.size;
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...left, ...right]).size;
  if (union === 0) return 0;
  return intersection / union;
}

function normalizeTextList(values: readonly string[], fieldName: string): string[] {
  if (!Array.isArray(values)) {
    throw new Error(`Metacognitive field "${fieldName}" must be an array`);
  }
  return values
    .map((value, index) => normalizeText(value, `${fieldName}[${String(index)}]`))
    .filter(value => value.length > 0);
}

function normalizeText(value: string, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Metacognitive field "${fieldName}" must be a string`);
  }
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeNonEmptyText(value: string, fieldName: string): string {
  const normalized = normalizeText(value, fieldName);
  if (normalized.length === 0) {
    throw new Error(`Metacognitive field "${fieldName}" must not be empty`);
  }
  return normalized;
}

function parseUnit(value: number, fieldName: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Metacognitive field "${fieldName}" must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`Metacognitive field "${fieldName}" must be in range [0, 1]`);
  }
  return roundDecimal(value);
}

function parseSignedUnit(value: number, fieldName: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Metacognitive field "${fieldName}" must be a finite number`);
  }
  if (value < -1 || value > 1) {
    throw new Error(`Metacognitive field "${fieldName}" must be in range [-1, 1]`);
  }
  return roundDecimal(value);
}

function parsePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Metacognitive field "${fieldName}" must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Metacognitive field "${fieldName}" must be a non-negative integer`);
  }
  return value;
}

function parseNonNegativeFinite(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Metacognitive field "${fieldName}" must be a non-negative finite number`);
  }
  return roundDecimal(value);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function roundDecimal(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
