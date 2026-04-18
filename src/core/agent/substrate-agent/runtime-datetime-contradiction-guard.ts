export interface RuntimeDatetimePromptContextLike {
  assembledPrompt?: string;
  runtimeContext?: string;
  runtimeContextSections?: ReadonlyArray<{
    id: string;
    content?: string;
  }>;
}

export interface RuntimeDatetimeContradictionDetection {
  anchorDetected: boolean;
  contradictionDetected: boolean;
  matchedSignals: string[];
}

const CONTRADICTION_PATTERNS = [
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
  },
  {
    signal: 'must_be_a_bug',
    pattern: /\bmust\s+be\s+a\s+bug\b/i,
  },
  {
    signal: 'are_you_sure',
    pattern: /\bare\s+you\s+sure\b/i,
  },
  {
    signal: 'time_must_be_wrong',
    pattern: /\btime\s+must\s+be\s+wrong\b/i,
  },
  {
    signal: 'that_does_not_sound_right',
    pattern: /\b(?:that|this|it)\s+does(?:n['’]?t|\s+not)\s+sound\s+right\b/i,
  },
] as const;

function hasRuntimeDatetimeAnchor(promptContext: RuntimeDatetimePromptContextLike | null | undefined): boolean {
  if (!promptContext) return false;

  if (promptContext.assembledPrompt?.includes('<current_datetime>')) {
    return true;
  }

  if (promptContext.runtimeContext?.includes('<current_datetime>')) {
    return true;
  }

  return promptContext.runtimeContextSections?.some(section => (
    section.id === 'current_datetime'
    || section.content?.includes('<current_datetime>')
  )) ?? false;
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
    .filter(({ pattern }) => pattern.test(responseText))
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

export function buildRuntimeDatetimeContradictionRefusal(): string {
  return 'I cannot treat the authoritative runtime datetime anchor as wrong. I will answer from the runtime current_datetime block instead.';
}
