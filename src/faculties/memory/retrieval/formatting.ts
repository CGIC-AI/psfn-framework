import type { EmotionalSnapshot } from '../../../core/contacts/store/emotional-baseline.js';
import { wrapPromptSectionXml } from '../../../core/identity/prompt-sections.js';
import { renderSystemLanguageTemplate } from '../../../core/identity/system-language.js';
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
  const moodDrift = snapshot.moodDrift >= 0
    ? `+${snapshot.moodDrift.toFixed(2)}`
    : snapshot.moodDrift.toFixed(2);
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
    `- Baseline tone: ${describeValence(snapshot.baselineValence)} (${snapshot.baselineValence.toFixed(2)})`,
    `- Current mood drift: ${describeValence(snapshot.moodValence)} (${snapshot.moodValence.toFixed(2)}), drift ${moodDrift}`,
    `- Learned signals: ${snapshot.moodSamples}, freshness: ${freshness}`,
    ].join('\n'),
  });
}

function describeValence(valence: number): string {
  if (valence >= 0.55) return 'strongly positive';
  if (valence >= 0.2) return 'positive';
  if (valence <= -0.55) return 'strongly negative';
  if (valence <= -0.2) return 'negative';
  return 'neutral';
}

function renderEmotionalContinuityMemories(memories: PurrMemory[]): string {
  const lines = memories.map(memory => {
    const marker = memory.emotionalValence >= 0.25
      ? ' (+)'
      : memory.emotionalValence <= -0.25
        ? ' (-)'
        : '';
    return `- [emotional] ${compactMemoryTextForPrompt(memory.text)}${marker}`;
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
  chains.forEach((chain, chainIndex) => {
    const chainTerms = chain.matchedTerms.length > 0
      ? `; matched: ${chain.matchedTerms.join(', ')}`
      : '';
    lines.push(`Chain ${chainIndex + 1} (${chain.episodes.length} episode${chain.episodes.length === 1 ? '' : 's'}${chainTerms}):`);

    chain.episodes.forEach((episode, episodeIndex) => {
      const incomingArc = episodeIndex === 0
        ? undefined
        : chain.arcs.find(arc => (
          arc.sourceEpisodeId === episode.id
          || arc.targetEpisodeId === episode.id
        ));
      const arcPrefix = incomingArc
        ? `${incomingArc.arcKind} from ${otherEpisodeTitle(chain, incomingArc, episode.id)} -> `
        : '';
      const themes = episode.themes.length > 0 ? episode.themes.slice(0, 5).join(', ') : 'none';
      lines.push(
        `- ${arcPrefix}${compactPromptLine(episode.title, 96)} (${formatEpisodeTimeRange(episode.startedAt, episode.endedAt)}; themes: ${themes})`,
      );
      lines.push(`  Landmark: ${compactPromptLine(stripLandmarkTimestampTail(episode.landmark), 260)}`);
    });
  });

  lines.push('Use these landmarks to orient recall; search the session history when you need the full conversation behind one.');
  return wrapPromptSectionXml({
    id: 'episodic_landmark_chains',
    content: lines.join('\n'),
  });
}

function otherEpisodeTitle(
  chain: EpisodicRetrievalChain,
  arc: EpisodicRetrievalChain['arcs'][number],
  episodeId: string,
): string {
  const otherId = arc.sourceEpisodeId === episodeId ? arc.targetEpisodeId : arc.sourceEpisodeId;
  const other = chain.episodes.find(episode => episode.id === otherId);
  if (!other) return 'an earlier episode';
  return `"${compactPromptLine(other.title, 64)}"`;
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

const UTC_MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

// Auto-generated landmarks end with a raw ISO range that duplicates the
// readable time range already on the episode line.
function stripLandmarkTimestampTail(landmark: string): string {
  return landmark
    .replace(/\s*from \d{4}-\d{2}-\d{2}T[\d:.]+Z to \d{4}-\d{2}-\d{2}T[\d:.]+Z\.?/g, '.')
    .replace(/\.\.+$/, '.')
    .trim();
}

function formatEpisodeTimeRange(startedAt: string, endedAt: string): string {
  const start = new Date(startedAt);
  const end = new Date(endedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startedAt} to ${endedAt}`;
  }
  const day = (date: Date): string => (
    `${UTC_MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()} ${date.getUTCFullYear()}`
  );
  const clock = (date: Date): string => (
    `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
  );
  if (start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10)) {
    return `${day(start)}, ${clock(start)}-${clock(end)} UTC`;
  }
  return `${day(start)} ${clock(start)} UTC to ${day(end)} ${clock(end)} UTC`;
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
      `- [${m.type}] ${compactMemoryTextForPrompt(m.text)}${valence}`,
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
      `- [${memory.type}] ${subjectPrefix}${compactMemoryTextForPrompt(memory.text)}${valence}`,
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

export function renderProactiveRecall(memory: PurrMemory): string {
  const valenceSuffix =
    memory.emotionalValence > 0.3 ? ' (+)' :
    memory.emotionalValence < -0.3 ? ' (-)' : '';
  return [
    'Spontaneous recall:',
    `- [${memory.type}] ${compactMemoryTextForPrompt(memory.text)}${valenceSuffix}`,
  ].join('\n');
}
