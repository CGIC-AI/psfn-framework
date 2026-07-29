import {
  getPromptPlanBlockText,
  renderPromptPlanAssembledPrompt,
  serializePromptPlanSystemPrompt,
  type PromptPlan,
} from './turn-execution/prompt-plan.js';

export interface RuntimeDatetimePromptContextLike {
  assembledPrompt?: string;
  runtimeContext?: string;
  finalSystemPrompt?: string;
  runtimeContextSections?: ReadonlyArray<{
    id: string;
    content?: string;
  }>;
  finalSystemSections?: ReadonlyArray<{
    id: string;
    content?: string;
  }>;
}

export interface RuntimeDatetimeContradictionDetection {
  anchorDetected: boolean;
  contradictionDetected: boolean;
  matchedSignals: string[];
}

interface ContradictionPattern {
  signal: string;
  pattern: RegExp;
  /**
   * Broad conversational phrases ("are you sure", "must be a bug") are only
   * datetime dissent when they occur near an explicit time reference
   * (psfn-framework-upx0.13). Datetime-inherent phrases ("the clock is off")
   * match unconditionally. Without this gate, a valid reply containing
   * "are you sure?" about anything became a datetime contradiction whenever a
   * runtime datetime anchor existed — which is every normal turn.
   */
  requiresDatetimeAdjacency?: boolean;
}

const CONTRADICTION_PATTERNS: readonly ContradictionPattern[] = [
  {
    signal: 'time_is_wrong',
    pattern: /\b(?:the\s+)?time\s+is\s+wrong\b/i,
  },
  {
    signal: 'clock_is_off',
    pattern: /\bclock\s+(?:is\s+)?off\b/i,
  },
  {
    signal: 'clock_must_be_off',
    pattern: /\bclock\s+must\s+be\s+off\b/i,
  },
  {
    signal: 'cannot_be_right',
    pattern: /\b(?:can['’]?t|cannot)\s+be\s+right\b/i,
    requiresDatetimeAdjacency: true,
  },
  {
    signal: 'must_be_a_bug',
    pattern: /\bmust\s+be\s+a\s+bug\b/i,
    requiresDatetimeAdjacency: true,
  },
  {
    signal: 'are_you_sure',
    pattern: /\bare\s+you\s+sure\b/i,
    requiresDatetimeAdjacency: true,
  },
  {
    signal: 'time_must_be_wrong',
    pattern: /\btime\s+must\s+be\s+wrong\b/i,
  },
  {
    signal: 'that_does_not_sound_right',
    pattern: /\b(?:that|this|it)\s+does(?:n['’]?t|\s+not)\s+sound\s+right\b/i,
    requiresDatetimeAdjacency: true,
  },
] as const;

/**
 * Explicit time references that make a broad dissent phrase datetime-flavored.
 * Word terms plus digital-clock (`9:30`), ISO-date (`2026-03-18`), and
 * `9 am`/`9 p.m.` shapes. The bare month name "May" is deliberately omitted
 * (case-insensitive matching would hit the modal verb "may" in ordinary
 * prose); a genuine May-date dispute virtually always carries another time
 * term or a digit shape this pattern does catch.
 */
const DATETIME_REFERENCE_PATTERN = new RegExp(
  [
    String.raw`\b(?:date(?:time)?s?|time(?:stamp|zone)?s?|clocks?|calendars?|today|tonight|tomorrow|yesterday|mornings?|afternoons?|evenings?|midnight|noon|hours?|minutes?|days?|weeks?|months?|years?|o['’]?clock)\b`,
    String.raw`\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b`,
    String.raw`\b(?:january|february|march|april|june|july|august|september|october|november|december)\b`,
    String.raw`\b\d{1,2}:\d{2}(?::\d{2})?\b`,
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
    String.raw`\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b`,
  ].join('|'),
  'i',
);

/**
 * Characters of surrounding response text, on each side of a broad-phrase
 * match, searched for a datetime reference — roughly the enclosing clause or
 * sentence pair, so "That can't be right — my clock says 9:30" still counts
 * across the punctuation boundary while a datetime mention elsewhere in a long
 * reply does not convert an unrelated "are you sure?" into datetime dissent.
 */
const DATETIME_ADJACENCY_WINDOW_CHARS = 160;

function hasDatetimeAdjacentMatch(pattern: RegExp, responseText: string): boolean {
  const globalPattern = new RegExp(pattern.source, `${pattern.flags.replace(/g/g, '')}g`);
  for (const match of responseText.matchAll(globalPattern)) {
    const matchIndex = match.index;
    const windowStart = Math.max(0, matchIndex - DATETIME_ADJACENCY_WINDOW_CHARS);
    const windowEnd = Math.min(
      responseText.length,
      matchIndex + match[0].length + DATETIME_ADJACENCY_WINDOW_CHARS,
    );
    if (DATETIME_REFERENCE_PATTERN.test(responseText.slice(windowStart, windowEnd))) {
      return true;
    }
  }
  return false;
}

function hasRuntimeDatetimeAnchor(promptContext: RuntimeDatetimePromptContextLike | null | undefined): boolean {
  if (!promptContext) return false;

  if (
    promptContext.assembledPrompt?.includes('<runtime.current_datetime')
    || promptContext.assembledPrompt?.includes('<current_datetime>')
    || promptContext.finalSystemPrompt?.includes('<runtime.current_datetime')
    || promptContext.finalSystemPrompt?.includes('<current_datetime>')
  ) {
    return true;
  }

  if (
    promptContext.runtimeContext?.includes('<runtime.current_datetime')
    || promptContext.runtimeContext?.includes('<current_datetime>')
  ) {
    return true;
  }

  return (promptContext.runtimeContextSections?.some(section => (
    section.id === 'current_datetime'
    || section.id === 'runtime_current_datetime'
    || section.id === 'runtime.current_datetime'
    || section.content?.includes('<runtime.current_datetime')
    || section.content?.includes('<current_datetime>')
  )) ?? false) || (promptContext.finalSystemSections?.some(section => (
    section.id === 'current_datetime'
    || section.id === 'runtime_current_datetime'
    || section.id === 'runtime.current_datetime'
    || section.content?.includes('<runtime.current_datetime')
    || section.content?.includes('<current_datetime>')
  )) ?? false);
}

/**
 * Build the detection context from the turn's PromptPlan (the shipped prompt)
 * plus section telemetry. The plan is the source of truth for what the
 * provider actually received (E2.2).
 */
export function buildRuntimeDatetimeDetectionContext(input: {
  plan?: PromptPlan;
  promptContext?: RuntimeDatetimePromptContextLike | null;
}): RuntimeDatetimePromptContextLike {
  return {
    ...(input.plan
      ? {
        assembledPrompt: renderPromptPlanAssembledPrompt(input.plan),
        finalSystemPrompt: serializePromptPlanSystemPrompt(input.plan),
        runtimeContext: getPromptPlanBlockText(input.plan, 'runtime.context'),
      }
      : {}),
    ...(input.promptContext?.runtimeContextSections
      ? { runtimeContextSections: input.promptContext.runtimeContextSections }
      : {}),
    ...(input.promptContext?.finalSystemSections
      ? { finalSystemSections: input.promptContext.finalSystemSections }
      : {}),
  };
}

export function detectRuntimeDatetimeContradiction(
  promptContext: RuntimeDatetimePromptContextLike | null | undefined,
  responseText: string,
): RuntimeDatetimeContradictionDetection {
  const anchorDetected = hasRuntimeDatetimeAnchor(promptContext);
  if (!anchorDetected) {
    return {
      anchorDetected: false,
      contradictionDetected: false,
      matchedSignals: [],
    };
  }

  const matchedSignals = CONTRADICTION_PATTERNS
    .filter(({ pattern, requiresDatetimeAdjacency }) => (
      requiresDatetimeAdjacency
        ? hasDatetimeAdjacentMatch(pattern, responseText)
        : pattern.test(responseText)
    ))
    .map(({ signal }) => signal);

  return {
    anchorDetected: true,
    contradictionDetected: matchedSignals.length > 0,
    matchedSignals,
  };
}

export function buildRuntimeDatetimeAnchorRetryPrompt(baseSystemPrompt: string): string {
  const strengthenedAnchor = [
    '<runtime_datetime_guard>',
    'The runtime current_datetime block is authoritative for this turn.',
    'Do not claim the clock is wrong, off, buggy, or doubtful.',
    'If a draft response starts to dispute the anchor, discard that framing and answer from the authoritative runtime datetime block instead.',
    '</runtime_datetime_guard>',
  ].join('\n');

  return [baseSystemPrompt.trim(), strengthenedAnchor]
    .filter(section => section.length > 0)
    .join('\n\n');
}

export function buildRuntimeDatetimeContradictionSystemNote(): string {
  return [
    'Runtime datetime concern: the previous assistant response still disputed the authoritative runtime current_datetime anchor after the strengthened-anchor retry.',
    'The response was preserved verbatim as companion-authored speech.',
    "On the next turn, use that turn's runtime current_datetime block as the authoritative clock.",
  ].join(' ');
}
