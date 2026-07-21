import type { EmotionalSnapshot } from '../../../core/contacts/store/emotional-baseline.js';
import { wrapPromptSectionXml } from '../../../core/identity/prompt-sections.js';
import { renderSystemLanguageTemplate } from '../../../core/identity/system-language.js';
import { formatActiveDate, resolveActiveTimezone } from '../../../shared/time/active-timezone.js';
import { isBoundaryMemory } from '../boundary-log.js';
import type {
  ContactProfileArtifact,
  MemoryEvolutionRelation,
} from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import {
  formatMemoryWithheldRelevanceBandLabel,
  formatMemoryWithheldReasonLabel,
  listMemoryWithheldRelevanceBandEntries,
  listMemoryWithheldReasonEntries,
  type MemoryWithheldSummary,
} from '../withheld-summary.js';
import type { EpisodicRetrievalChain } from './episodic.js';
import type {
  RetrievalContactContext,
  RetrievalSocialContext,
  ScoredMemory,
} from './types.js';

export function renderPromptBlock(
  profile: ContactProfileArtifact | undefined,
  scored: ScoredMemory[] = [],
  options?: {
    emotionalSnapshot?: EmotionalSnapshot;
    emotionalContinuityMemories?: PurrMemory[];
    withheldSummary?: MemoryWithheldSummary;
    socialContext?: RetrievalSocialContext;
    contactContextById?: ReadonlyMap<string, RetrievalContactContext>;
    episodicChains?: EpisodicRetrievalChain[];
  },
): string {
  const sections: string[] = [];
  const socialContext = options?.socialContext;
  if (profile && profile.summary.trim().length > 0) {
    sections.push(wrapPromptSectionXml({
      id: 'core_profile',
      content: `Core profile for this person:\n${profile.summary.trim()}`,
    }));
  }
  if ((socialContext?.relatedContactsById.size ?? 0) > 0 && socialContext) {
    sections.push(renderSocialContext(socialContext));
  }
  if (options?.emotionalSnapshot) {
    sections.push(renderEmotionalSnapshot(options.emotionalSnapshot));
  }
  if ((options?.emotionalContinuityMemories?.length ?? 0) > 0) {
    sections.push(renderEmotionalContinuityMemories(options?.emotionalContinuityMemories ?? []));
  }
  if (options?.withheldSummary && options.withheldSummary.totalCount > 0) {
    sections.push(renderWithheldSummary(options.withheldSummary));
  }
  if ((options?.episodicChains?.length ?? 0) > 0) {
    sections.push(renderEpisodicLandmarkChains(options?.episodicChains ?? []));
  }
  if (scored.length > 0) {
    sections.push(formatMemoriesForPrompt(
      scored,
      options?.socialContext,
      options?.contactContextById,
    ));
  }
  return sections.join('\n\n');
}

function renderSocialContext(context: RetrievalSocialContext): string {
  const lines = [...context.relatedContactsById.values()]
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
    .map(contact => {
      const relation = contact.relationshipLabels.length > 0
        ? contact.relationshipLabels.join(', ')
        : 'known relation';
      return `- ${contact.displayName} is a separate person connected to ${context.canonicalDisplayName} as ${relation}.`;
  });
  lines.push(`- Keep memories about related people attributed to the named person instead of merging them into ${context.canonicalDisplayName}.`);
  return wrapPromptSectionXml({
    id: 'relationship_context',
    content: `Relationship context for this person:\n${lines.join('\n')}`,
  });
}

function renderEmotionalSnapshot(snapshot: EmotionalSnapshot): string {
  const ageMs = snapshot.lastMoodUpdateEpochMs !== undefined
    ? Math.max(0, Date.now() - snapshot.lastMoodUpdateEpochMs)
    : null;
  const freshness = ageMs === null
    ? 'unknown'
    : ageMs <= (6 * 60 * 60 * 1000)
      ? 'active-session'
      : 'historical';

  return wrapPromptSectionXml({
    id: 'emotional_continuity_snapshot',
    content: [
    'Emotional continuity snapshot:',
    `- Steady baseline: ${describeValence(snapshot.baselineValence)}; baseline disposition: ${describeBaselineDisposition(snapshot.baselineValence)}.`,
    `- Current state: ${describeCurrentState(snapshot)}.`,
    `- Signal confidence: ${describeSignalConfidence(snapshot.moodSamples)}; freshness: ${freshness}.`,
    ].join('\n'),
  });
}

function describeCurrentState(snapshot: EmotionalSnapshot): string {
  const driftStrength = Math.abs(snapshot.moodDrift);
  const currentValence = describeValence(snapshot.moodValence);
  if (driftStrength < 0.05) {
    return `holding close to the baseline at ${currentValence}`;
  }
  const strength = driftStrength >= 0.55
    ? 'strongly'
    : driftStrength >= 0.2
      ? 'noticeably'
      : 'gently';
  return `currently drifting ${strength} toward ${currentValence}`;
}

function describeSignalConfidence(moodSamples: number): string {
  if (moodSamples >= 8) return 'well established';
  if (moodSamples >= 3) return 'developing';
  if (moodSamples >= 1) return 'tentative';
  return 'unestablished';
}

function describeValence(valence: number): string {
  if (valence >= 0.55) return 'strongly positive';
  if (valence >= 0.2) return 'positive';
  if (valence <= -0.55) return 'strongly negative';
  if (valence <= -0.2) return 'negative';
  return 'neutral';
}

/**
 * A qualitative baseline disposition derived from the actual baseline valence,
 * so the phrase can never contradict the stated baseline (cf5y). Kept qualitative
 * — no raw telemetry — matching the rest of this companion-facing block.
 */
function describeBaselineDisposition(valence: number): string {
  if (valence >= 0.55) return 'warm, bright, and curious';
  if (valence >= 0.2) return 'warm, steady, and curious';
  if (valence <= -0.55) return 'heavy, withdrawn, and tender';
  if (valence <= -0.2) return 'subdued, careful, and quiet';
  return 'even, grounded, and open';
}

function renderEmotionalContinuityMemories(memories: PurrMemory[]): string {
  const lines = memories.map(memory => {
    const marker = memory.emotionalValence >= 0.25
      ? ' (+)'
      : memory.emotionalValence <= -0.25
        ? ' (-)'
        : '';
    return `- [emotional] ${compactMemoryTextForPrompt(memory.text)}${marker}${recencyBandSuffix(memory.extractedAt)}`;
  });
  return wrapPromptSectionXml({
    id: 'cross_session_emotional_continuity',
    content: `Cross-session emotional continuity:\n${lines.join('\n')}`,
  });
}

function renderWithheldSummary(summary: MemoryWithheldSummary): string {
  const detailLine = listMemoryWithheldReasonEntries(summary.reasonCounts)
    .map(({ reason, count }) => `${count} ${formatMemoryWithheldReasonLabel(reason)}`)
    .join(', ');
  const relevanceLine = listMemoryWithheldRelevanceBandEntries(summary.relevanceBands ?? {})
    .map(({ band, count }) => `${count} ${formatMemoryWithheldRelevanceBandLabel(band)}`)
    .join(', ');
  const plural = summary.totalCount === 1 ? 'memory was' : 'memories were';
  return wrapPromptSectionXml({
    id: 'memory_context_note',
    content: [
      renderSystemLanguageTemplate('memory_context_note.header'),
      renderSystemLanguageTemplate('memory_context_note.withheld_count', {
        total_count: summary.totalCount,
        memory_noun: plural,
      }),
      ...(detailLine
        ? [renderSystemLanguageTemplate('memory_context_note.reasons', { detail_line: detailLine })]
        : []),
      ...(relevanceLine
        ? [renderSystemLanguageTemplate('memory_context_note.relevance', { relevance_line: relevanceLine })]
        : []),
      renderSystemLanguageTemplate('memory_context_note.safe_next_actions'),
    ].join('\n'),
  });
}

function renderEpisodicLandmarkChains(chains: readonly EpisodicRetrievalChain[]): string {
  const lines = ['Episodes from your shared history related to this conversation:'];
  // Keep the always-on block bounded: cap the total episodes across all chains
  // and take them most-relevant-first (highest-scoring chains, root episodes
  // first within a chain). Arc expansion is intentionally omitted here -- arc
  // detail belongs to the episode drill-down path, not the always-injected
  // block, so it cannot ride in ungated.
  const episodeCap = 5;
  const orderedChains = [...chains].sort((left, right) => right.score - left.score);
  let renderedEpisodes = 0;
  orderedChains.forEach((chain, chainIndex) => {
    if (renderedEpisodes >= episodeCap) return;
    const episodes = chain.episodes.slice(0, episodeCap - renderedEpisodes);
    if (episodes.length === 0) return;
    const chainTerms = chain.matchedTerms.length > 0
      ? `; matched: ${chain.matchedTerms.join(', ')}`
      : '';
    lines.push(`Chain ${chainIndex + 1} (${chain.episodes.length} episode${chain.episodes.length === 1 ? '' : 's'}${chainTerms}):`);

    episodes.forEach((episode) => {
      const themes = episode.themes.length > 0 ? episode.themes.slice(0, 5).join(', ') : 'none';
      lines.push(
        `- Episode ${episode.id}: ${compactPromptLine(episode.title, 96)} (${formatEpisodeTimeRange(episode.startedAt, episode.endedAt)}; themes: ${themes})`,
      );
      lines.push(`  Landmark: ${compactPromptLine(stripLandmarkTimestampTail(episode.landmark), 260)}`);
      const meaning = episode.meaning?.text.trim();
      if (meaning) {
        lines.push(`  Meaning: ${compactPromptLine(meaning, 200)}`);
      }
      renderedEpisodes++;
    });
  });

  lines.push('Use these landmarks to orient recall; search the session history when you need the full conversation behind one.');
  return wrapPromptSectionXml({
    id: 'episodic_landmark_chains',
    content: lines.join('\n'),
  });
}

function compactPromptLine(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3)}...`;
}

// Memory text written by reflection/deliberation flows can carry machine
// artifacts (fenced JSON self-reports, carry-forward scaffolding) appended
// after the narrative paragraph. The narrative is the memory; the artifact
// belongs to records and tooling, never to companion-facing context.
// Exported so the reflection writer can store narrative-only text at the
// source; this render-time pass remains the safety net for legacy memories.
export function compactMemoryTextForPrompt(text: string): string {
  const fenceIndex = text.indexOf('```');
  const narrative = (fenceIndex >= 0 ? text.slice(0, fenceIndex) : text)
    .replace(/\*\*carry_forward:\*\*[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (narrative.length > 0) return narrative;
  return text.replace(/\s+/g, ' ').trim();
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MEAN_DAYS_PER_MONTH = 30.44;

// Day index of a moment on the active-timezone calendar, so today/yesterday
// boundaries follow the companion's clock rather than UTC.
function activeCalendarDayIndex(atMs: number): number {
  const [year, month, day] = formatActiveDate(new Date(atMs)).split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

/**
 * Coarse age band for a retrieved memory, derived from extraction time:
 * (today) / (yesterday) / (this week) / (N weeks ago) / (N months ago) /
 * (N years ago). Returns undefined when extractedAt is missing or invalid —
 * rendering must degrade to a bandless line, never crash.
 */
export function formatMemoryRecencyBand(
  extractedAtMs: number | undefined,
  nowMs: number = Date.now(),
): string | undefined {
  if (extractedAtMs === undefined || !Number.isFinite(extractedAtMs) || !Number.isFinite(nowMs)) {
    return undefined;
  }
  const dayDiff = activeCalendarDayIndex(nowMs) - activeCalendarDayIndex(extractedAtMs);
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff < 7) return 'this week';
  const weeks = Math.floor(dayDiff / 7);
  if (weeks <= 8) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  const months = Math.floor(dayDiff / MEAN_DAYS_PER_MONTH);
  if (months < 24) return `${months} months ago`;
  const years = Math.floor(months / 12);
  return `${years} years ago`;
}

function recencyBandSuffix(extractedAtMs: number | undefined): string {
  const band = formatMemoryRecencyBand(extractedAtMs);
  return band === undefined ? '' : ` (${band})`;
}

// Auto-generated landmarks end with a raw ISO range that duplicates the
// readable time range already on the episode line.
function stripLandmarkTimestampTail(landmark: string): string {
  return landmark
    .replace(/\s*from \d{4}-\d{2}-\d{2}T[\d:.]+Z to \d{4}-\d{2}-\d{2}T[\d:.]+Z\.?/g, '.')
    .replace(/\.\.+$/, '.')
    .trim();
}

// Episode ranges render in the active timezone so they share one clock with
// every other temporal signal in the prompt (runtime clock, wake notes,
// continuity anchor), and carry the active tz label instead of UTC.
function formatEpisodeTimeRange(startedAt: string, endedAt: string): string {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startedAt} to ${endedAt}`;
  }
  const timeZone = resolveActiveTimezone();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = (date: Date): Record<string, string> => Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  const startParts = parts(start);
  const endParts = parts(end);
  const day = (p: Record<string, string>): string => `${p.month} ${p.day} ${p.year}`;
  const clock = (p: Record<string, string>): string => `${p.hour}:${p.minute}`;
  if (formatActiveDate(start) === formatActiveDate(end)) {
    return `${day(startParts)}, ${clock(startParts)}-${clock(endParts)} ${timeZone}`;
  }
  return `${day(startParts)} ${clock(startParts)} to ${day(endParts)} ${clock(endParts)} ${timeZone}`;
}

function formatMemoriesForPrompt(
  scored: ScoredMemory[],
  socialContext?: RetrievalSocialContext,
  contactContextById?: ReadonlyMap<string, RetrievalContactContext>,
): string {
  const boundaryMemories = scored.filter(item => isBoundaryMemory(item.memory));
  const nonBoundaryMemories = scored.filter(item => !isBoundaryMemory(item.memory));
  const sections: string[] = [];

  if (boundaryMemories.length > 0) {
    sections.push(renderMemorySection(
      'Active safety boundaries from prior refusals:',
      boundaryMemories,
    ));
  }
  if (nonBoundaryMemories.length > 0) {
    if (socialContext) {
      sections.push(...renderSociallyScopedMemorySections(
        nonBoundaryMemories,
        socialContext,
        contactContextById,
      ));
    } else {
      sections.push(renderMemorySection(
        'Relevant memories for this person:',
        nonBoundaryMemories,
      ));
    }
  }

  return sections.join('\n\n');
}

function renderSociallyScopedMemorySections(
  scored: ScoredMemory[],
  socialContext: RetrievalSocialContext,
  contactContextById?: ReadonlyMap<string, RetrievalContactContext>,
): string[] {
  const canonical: ScoredMemory[] = [];
  const related: ScoredMemory[] = [];
  const separatePeople: ScoredMemory[] = [];

  for (const item of scored) {
    const contactId = item.memory.contactId?.trim();
    if (!contactId || contactId === socialContext.canonicalContactId) {
      canonical.push(item);
      continue;
    }
    if (socialContext.relatedContactsById.has(contactId)) {
      related.push(item);
      continue;
    }
    separatePeople.push(item);
  }

  const sections: string[] = [];
  if (canonical.length > 0) {
    sections.push(renderMemorySection('Relevant memories for this person:', canonical));
  }
  if (related.length > 0) {
    sections.push(renderAttributedMemorySection(
      'Relevant memories about other people in their social context:',
      related,
      contactContextById,
    ));
  }
  if (separatePeople.length > 0) {
    sections.push(renderAttributedMemorySection(
      'Relevant memories about other separate people:',
      separatePeople,
      contactContextById,
    ));
  }

  return sections;
}

function renderMemorySection(heading: string, scored: ScoredMemory[]): string {
  const lines = scored.flatMap(s => {
    const m = s.memory;
    const valence =
      m.emotionalValence > 0.3 ? ' (+)' :
      m.emotionalValence < -0.3 ? ' (-)' : '';
    return [
      `- [${m.type}] ${compactMemoryTextForPrompt(m.text)}${valence}${recencyBandSuffix(m.extractedAt)}`,
      ...formatEvolutionChainLines(s),
    ];
  });

  return wrapPromptSectionXml({
    id: heading === 'Active safety boundaries from prior refusals:'
      ? 'active_safety_boundaries'
      : heading === 'Relevant memories for this person:'
        ? 'relevant_memories'
        : 'memory_section',
    content: `${heading}\n${lines.join('\n')}`,
  });
}

function renderAttributedMemorySection(
  heading: string,
  scored: ScoredMemory[],
  contactContextById?: ReadonlyMap<string, RetrievalContactContext>,
): string {
  const lines = scored.flatMap(s => {
    const memory = s.memory;
    const valence =
      memory.emotionalValence > 0.3 ? ' (+)' :
      memory.emotionalValence < -0.3 ? ' (-)' : '';
    const descriptor = memory.contactId ? contactContextById?.get(memory.contactId) : undefined;
    const subjectPrefix = descriptor
      ? `${descriptor.displayName}${formatContactDescriptorSuffix(descriptor)}: `
      : '';
    return [
      `- [${memory.type}] ${subjectPrefix}${compactMemoryTextForPrompt(memory.text)}${valence}${recencyBandSuffix(memory.extractedAt)}`,
      ...formatEvolutionChainLines(s),
    ];
  });
  return wrapPromptSectionXml({
    id: heading.includes('social context')
      ? 'social_context_memories'
      : 'separate_people_memories',
    content: `${heading}\n${lines.join('\n')}`,
  });
}

function formatEvolutionChainLines(scored: ScoredMemory): string[] {
  if (!scored.evolutionChain || scored.evolutionChain.length === 0) return [];
  return scored.evolutionChain.map(link => (
    `  - ${formatEvolutionRelation(link.relation)} [${link.memory.type}] ${compactMemoryTextForPrompt(link.memory.text)}${link.confidence < 0.6 ? ' (tentative link)' : ''}`
  ));
}

function formatEvolutionRelation(relation: MemoryEvolutionRelation): string {
  switch (relation) {
    case 'supersedes':
      return 'Supersedes';
    case 'updates':
      return 'Updates';
    case 'negates':
      return 'Negates';
    case 'conflicts_with':
      return 'Conflicts with';
  }
}

function formatContactDescriptorSuffix(descriptor: RetrievalContactContext): string {
  const cues: string[] = [];
  if (descriptor.relatedToCanonical && descriptor.relationshipLabels.length > 0) {
    cues.push(descriptor.relationshipLabels.join(', '));
  } else if (descriptor.relationshipType.trim().length > 0) {
    cues.push(descriptor.relationshipType);
  }
  cues.push(`${descriptor.trustLevel} contact`);
  return ` [${cues.join('; ')}]`;
}
