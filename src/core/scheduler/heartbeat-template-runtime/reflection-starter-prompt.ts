import type {
  ReflectionContactRecentMessage,
  ReflectionDailyJournalEntry,
} from '../../../persistence/journals/reflection-substrate.js';
import {
  describeArousal,
  describeSignedValence,
  type ReflectionInternalStateContext,
  type ReflectionPromptSectionBundle,
} from './prompt-formatting.js';

const REFLECTION_STARTER_SHAPE = Object.freeze({
  eventCount: 3,
  clueCount: 2,
  lineLength: 220,
});

// The starter block precedes every default daily/weekly self-elicitation and is
// therefore part of the governed reflection instrument (R6).
export const REFLECTION_STARTER_PROMPT_VERSION = 1;

export interface ReflectionStarterPromptInput {
  templateId: string;
  internalStateContext: ReflectionInternalStateContext | null;
  retrievedMemoryBlock?: string;
  recentSessionMessages: readonly ReflectionContactRecentMessage[];
  recentDailyJournalEntries: ReadonlyArray<Pick<ReflectionDailyJournalEntry, 'date' | 'reflection'>>;
  provenanceRefs: readonly string[];
}

function truncateStarterLine(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= REFLECTION_STARTER_SHAPE.lineLength) {
    return normalized;
  }
  return `${normalized.slice(0, REFLECTION_STARTER_SHAPE.lineLength - 1).trimEnd()}…`;
}

function extractRetrievedEventLines(memoryBlock: string | undefined): string[] {
  if (!memoryBlock?.trim()) {
    return [];
  }

  const bulletLines = memoryBlock
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s+\S/.test(line))
    .map(line => line.replace(/^[-*]\s+/, ''));
  const typedMemoryPattern = /^\[(?:episodic|semantic|emotional|procedural|reflection|relational)\]\s+/i;
  const typedMemoryLines = bulletLines.filter(line => typedMemoryPattern.test(line));
  const eventCandidates = typedMemoryLines.length > 0
    ? typedMemoryLines
    : bulletLines.filter(line => !/^(?:Baseline tone|Current mood drift|Learned signals):/i.test(line));
  const lines = eventCandidates
    .map(line => line.replace(typedMemoryPattern, ''))
    .map(line => truncateStarterLine(line))
    .filter(Boolean);
  return lines.slice(0, REFLECTION_STARTER_SHAPE.eventCount);
}

function formatSessionEventLines(messages: readonly ReflectionContactRecentMessage[]): string[] {
  return messages.slice(-REFLECTION_STARTER_SHAPE.eventCount).map((message) => {
    const speaker = message.authorName?.trim()
      || (message.role === 'assistant' ? 'Companion' : 'Contact');
    return truncateStarterLine(`${speaker}: ${message.content}`);
  });
}

function formatWeeklyEventLines(
  entries: ReadonlyArray<Pick<ReflectionDailyJournalEntry, 'date' | 'reflection'>>,
): string[] {
  return entries.slice(0, REFLECTION_STARTER_SHAPE.eventCount).map(entry => (
    truncateStarterLine(`${entry.date}: ${entry.reflection}`)
  ));
}

function selectEventLines(input: ReflectionStarterPromptInput): string[] {
  const retrievedEvents = extractRetrievedEventLines(input.retrievedMemoryBlock);
  const sessionEvents = formatSessionEventLines(input.recentSessionMessages);
  const livedDayEvents = formatWeeklyEventLines(input.recentDailyJournalEntries);

  if (input.templateId === 'weekly-review') {
    return livedDayEvents.length > 0
      ? livedDayEvents
      : (retrievedEvents.length > 0 ? retrievedEvents : sessionEvents);
  }

  return retrievedEvents.length > 0
    ? retrievedEvents
    : (sessionEvents.length > 0 ? sessionEvents : livedDayEvents.slice(0, 1));
}

function formatHighSignalClues(context: ReflectionInternalStateContext | null): string[] {
  if (!context) {
    return [];
  }

  const state = context.internalState;
  const clues: string[] = [];
  if (state.emotional.telemetry.status === 'trusted') {
    clues.push(
      'Recent affect evidence appears '
      + `${describeSignedValence(state.emotional.vad.valence)}, `
      + `${describeArousal(state.emotional.vad.arousal)}; this is a fallible clue, not a conclusion.`,
    );
  }

  const concern = [...state.attention.activeConcerns]
    .sort((left, right) => right.salience - left.salience)
    .at(0);
  if (concern) {
    clues.push(`A currently salient thread: ${truncateStarterLine(concern.text)}`);
  }

  const followUp = state.attention.pendingFollowUps?.[0];
  if (clues.length < REFLECTION_STARTER_SHAPE.clueCount && followUp) {
    clues.push(`A near-term open loop: ${truncateStarterLine(followUp.content)}`);
  }

  return clues.slice(0, REFLECTION_STARTER_SHAPE.clueCount);
}

export function buildReflectionStarterPromptBundle(
  input: ReflectionStarterPromptInput,
): ReflectionPromptSectionBundle {
  const eventLines = selectEventLines(input);
  const clueLines = formatHighSignalClues(input.internalStateContext);
  const eventHeading = input.templateId === 'weekly-review'
    ? '[Week Events Starter]'
    : '[Day Events Starter]';
  const sections = [
    [
      eventHeading,
      'This is a small, fallible starting point rather than a complete account.',
      ...(eventLines.length > 0
        ? eventLines.map(line => `- ${line}`)
        : ['No event summary is present in the starter context; read-only introspection remains available if it would help.']),
    ].join('\n'),
    ...(clueLines.length > 0
      ? [[
        '[High-Signal Starter Clues]',
        ...clueLines.map(line => `- ${line}`),
      ].join('\n')]
      : []),
  ];

  return {
    self: sections.join('\n\n'),
    relational: '',
    affect: '',
    provenanceRefs: [...new Set(input.provenanceRefs.map(ref => ref.trim()).filter(Boolean))],
  };
}
