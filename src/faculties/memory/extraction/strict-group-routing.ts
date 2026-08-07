import type { SessionEntry } from '../../../core/session/types.js';
import { parseSessionMessageAddressing } from '../../../core/session/message-addressing.js';
import type { ExtractedFact, ExtractedFactAttribution } from '../types.js';

export type StrictGroupRoutingSkipReason =
  | 'missing_structured_addressing'
  | 'conflicting_source_attribution'
  | 'conflicting_resolved_addressee'
  | 'missing_subject_attribution'
  | 'conflicting_subject_attribution'
  | 'conflicting_subject_addressee'
  | 'conflicting_subject_contact'
  | 'conflicting_observer_attribution';

export type StrictGroupAddressingValidation = {
  status: 'ok';
  addressedParticipantNames: string[];
} | {
  status: 'skip';
  reason: StrictGroupRoutingSkipReason;
};

export interface StrictGroupSubjectSpeaker {
  normalizedName: string;
  contactId?: string;
}

export type StrictGroupSubjectResolution<Speaker extends StrictGroupSubjectSpeaker> = {
  status: 'ok';
  speaker?: Speaker;
} | {
  status: 'skip';
  reason: 'conflicting_subject_contact';
};

export function resolveStrictGroupSubject<Speaker extends StrictGroupSubjectSpeaker>(
  attribution: ExtractedFactAttribution,
  speakers: readonly Speaker[],
): StrictGroupSubjectResolution<Speaker> {
  const normalizedSubject = normalizeSpeakerPhrase(attribution.subjectName ?? '');
  const matches = normalizedSubject
    ? speakers.filter(speaker => speaker.normalizedName === normalizedSubject)
    : [];
  if (matches.length > 1) {
    return { status: 'skip', reason: 'conflicting_subject_contact' };
  }
  const speaker = matches.at(0);
  if (
    attribution.subjectContactId
    && attribution.subjectContactId !== speaker?.contactId
  ) {
    return { status: 'skip', reason: 'conflicting_subject_contact' };
  }
  return { status: 'ok', ...(speaker ? { speaker } : {}) };
}

export function validateStrictGroupAddressing(
  fact: ExtractedFact,
  attribution: ExtractedFactAttribution,
  sourceEntries: readonly SessionEntry[],
): StrictGroupAddressingValidation {
  const addressedEntries = sourceEntries.map(entry => ({
    entry,
    addressing: parseSessionMessageAddressing(entry.metadata),
  }));
  if (addressedEntries.some(item => item.addressing?.channel.scope !== 'group')) {
    return { status: 'skip', reason: 'missing_structured_addressing' };
  }
  for (const { entry, addressing } of addressedEntries) {
    if (
      !addressing
      || addressing.author.authorId !== entry.authorId?.trim()
      || addressing.author.authorName !== entry.authorName?.trim()
    ) {
      return { status: 'skip', reason: 'conflicting_source_attribution' };
    }
  }
  const first = addressedEntries[0]?.addressing;
  if (!first) return { status: 'skip', reason: 'missing_structured_addressing' };
  const addressingSignature = JSON.stringify({
    observer: first.observer,
    channel: first.channel,
    resolvedAddressee: first.resolvedAddressee,
  });
  if (addressedEntries.some(item => JSON.stringify({
    observer: item.addressing?.observer,
    channel: item.addressing?.channel,
    resolvedAddressee: item.addressing?.resolvedAddressee,
  }) !== addressingSignature)) {
    return { status: 'skip', reason: 'conflicting_resolved_addressee' };
  }

  const addressedParticipantNames = first.resolvedAddressee.kind === 'participants'
    ? first.resolvedAddressee.participants.flatMap(participant => (
      participant.authorId === first.observer.authorId
        ? [participant.authorName, first.observer.authorName]
        : [participant.authorName]
    ))
    : [];
  const normalizedSubject = normalizeSpeakerPhrase(attribution.subjectName ?? '');
  if (!normalizedSubject) return { status: 'skip', reason: 'missing_subject_attribution' };
  const normalizedFactText = normalizeSpeakerPhrase(fact.text);
  if (!hasSpeakerWord(normalizedFactText, normalizedSubject)) {
    return { status: 'skip', reason: 'conflicting_subject_attribution' };
  }
  if (first.resolvedAddressee.kind === 'participants') {
    const targetsObserver = first.resolvedAddressee.participants.some(participant => (
      participant.authorId === first.observer.authorId
    ));
    const otherTargets = first.resolvedAddressee.participants.filter(participant => (
      participant.authorId !== first.observer.authorId
    ));
    const observerName = normalizeSpeakerPhrase(first.observer.authorName);
    const sourceNamesObserver = sourceEntries.some(entry => (
      hasSpeakerWord(normalizeSpeakerPhrase(entry.content), observerName)
    ));
    const otherTargetSharesObserverName = otherTargets.some(participant => (
      normalizeSpeakerPhrase(participant.authorName) === observerName
    ));
    if (
      !targetsObserver
      && hasSpeakerWord(normalizedFactText, observerName)
      && !sourceNamesObserver
      && !otherTargetSharesObserverName
    ) {
      return { status: 'skip', reason: 'conflicting_observer_attribution' };
    }
    if (!targetsObserver && otherTargets.length > 0 && !otherTargets.some(participant => (
      hasSpeakerWord(normalizedFactText, normalizeSpeakerPhrase(participant.authorName))
    ))) {
      return { status: 'skip', reason: 'conflicting_subject_addressee' };
    }
  }
  return { status: 'ok', addressedParticipantNames };
}

export function normalizeSpeakerPhrase(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasSpeakerWord(normalized: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(normalized);
}
