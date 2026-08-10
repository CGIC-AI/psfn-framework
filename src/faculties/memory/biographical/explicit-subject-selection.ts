import type { ConversationScope } from '../../../core/session/conversation-scope.js';
import type {
  MessageAddresseeEvidence,
  MessageAddressingMetadata,
} from '../../../shared/contracts/message-addressing.js';
import { TRUST_LEVELS, type TrustLevel } from '../../../system/trust/types.js';
import type { BiographicalSubjectRef } from './types.js';

type ExplicitAddressEvidence = Extract<MessageAddresseeEvidence, 'mention' | 'reply'>;

export interface CanonicalAddressedContactInput {
  readonly source: MessageAddressingMetadata['source'];
  readonly transportParticipantId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly evidence: readonly ExplicitAddressEvidence[];
}

export type CanonicalAddressedContactResolution =
  | {
    readonly status: 'verified';
    readonly subject: Extract<BiographicalSubjectRef, { kind: 'contact' }>;
    readonly trustLevel: TrustLevel;
    /**
     * Independent, current transport participation authority. A recent-speaker
     * window or historical room roster is never sufficient for this proof.
     */
    readonly currentParticipation:
      | { readonly status: 'authoritative'; readonly proofRef: string }
      | { readonly status: 'unproven' };
  }
  | { readonly status: 'missing' | 'ambiguous' };

/**
 * Resolves a transport-authoritative participant ID to one canonical contact.
 * Display names are deliberately absent from the input so implementations
 * cannot turn user-controlled prose into identity authority.
 */
export interface CanonicalAddressedContactResolver {
  resolve(
    input: CanonicalAddressedContactInput,
  ): Promise<CanonicalAddressedContactResolution>;
}

export interface VerifiedExplicitSubject {
  readonly subject: Extract<BiographicalSubjectRef, { kind: 'contact' }>;
  readonly trustLevel: TrustLevel;
  readonly currentParticipation:
    | { readonly status: 'authoritative'; readonly proofRef: string }
    | { readonly status: 'unproven' };
}

export type ExplicitSubjectSelectionReason =
  | 'explicit-addressing-mismatch'
  | 'explicit-reply-unresolved'
  | 'explicit-contact-missing'
  | 'explicit-contact-ambiguous'
  | 'explicit-subject-limit';

export interface ExplicitSubjectSelectionWithheld {
  readonly addressedParticipantId?: string;
  readonly reason: ExplicitSubjectSelectionReason;
  readonly detail: string;
}

export interface ExplicitSubjectSelectionResult {
  readonly subjects: readonly VerifiedExplicitSubject[];
  readonly withheld: readonly ExplicitSubjectSelectionWithheld[];
}

export function hasExplicitSubjectAddressing(
  messageAddressing: MessageAddressingMetadata | undefined,
): boolean {
  if (messageAddressing === undefined) return false;
  if (messageAddressing.resolvedAddressee.kind === 'unresolved_reply') return true;
  return messageAddressing.mentionedTargets.some(target =>
    target.authorId !== messageAddressing.observer.authorId)
    || (
      messageAddressing.replyTarget?.author !== undefined
      && messageAddressing.replyTarget.author.authorId !== messageAddressing.observer.authorId
    );
}

function sameContactSubject(
  left: Extract<BiographicalSubjectRef, { kind: 'contact' }>,
  right: Extract<BiographicalSubjectRef, { kind: 'contact' }>,
): boolean {
  return left.contactId === right.contactId && left.subjectVersion === right.subjectVersion;
}

function sameParticipation(
  left: VerifiedExplicitSubject['currentParticipation'],
  right: VerifiedExplicitSubject['currentParticipation'],
): boolean {
  if (left.status !== right.status) return false;
  return left.status === 'unproven'
    || (right.status === 'authoritative' && left.proofRef === right.proofRef);
}

function hasValidVerifiedAuthority(
  resolution: Extract<CanonicalAddressedContactResolution, { status: 'verified' }>,
): boolean {
  if (
    !resolution.subject.contactId.trim()
    || !Number.isSafeInteger(resolution.subject.subjectVersion)
    || resolution.subject.subjectVersion < 1
    || !TRUST_LEVELS.includes(resolution.trustLevel)
  ) {
    return false;
  }
  if (resolution.currentParticipation.status === 'unproven') return true;
  return resolution.currentParticipation.proofRef.trim().length > 0;
}

function addressingBelongsToScope(
  messageAddressing: MessageAddressingMetadata,
  conversationScope: Extract<ConversationScope, { kind: 'group' }>,
): boolean {
  if (messageAddressing.channel.scope !== 'group') return false;
  if (messageAddressing.channel.threadId === undefined) {
    return messageAddressing.channel.channelId === conversationScope.channelId;
  }
  return conversationScope.channelId === messageAddressing.channel.threadId
    || conversationScope.channelId
      === `${messageAddressing.channel.channelId}:${messageAddressing.channel.threadId}`;
}

/**
 * Select explicit group-turn subjects from structured addressing only.
 * Resolution calls are bounded before any canonical-contact/store access, and
 * neither recent speakers nor a historical room roster participates.
 */
export async function selectExplicitSubjects(input: {
  readonly conversationScope: ConversationScope;
  readonly messageAddressing?: MessageAddressingMetadata;
  readonly resolver: CanonicalAddressedContactResolver;
  readonly maxSubjects: number;
}): Promise<ExplicitSubjectSelectionResult> {
  const { conversationScope, messageAddressing } = input;
  if (conversationScope.kind !== 'group' || messageAddressing === undefined) {
    return { subjects: [], withheld: [] };
  }

  if (
    !addressingBelongsToScope(messageAddressing, conversationScope)
  ) {
    return {
      subjects: [],
      withheld: [{
        reason: 'explicit-addressing-mismatch',
        detail: 'structured addressing does not belong to the current group scope',
      }],
    };
  }

  if (messageAddressing.resolvedAddressee.kind === 'unresolved_reply') {
    return {
      subjects: [],
      withheld: [{
        reason: 'explicit-reply-unresolved',
        detail: 'the structured reply target has no transport-authoritative participant identity',
      }],
    };
  }
  const explicitTargets = new Map<string, Set<ExplicitAddressEvidence>>();
  for (const target of messageAddressing.mentionedTargets) {
    if (target.authorId === messageAddressing.observer.authorId) continue;
    explicitTargets.set(target.authorId, new Set(['mention']));
  }
  if (
    messageAddressing.replyTarget?.author !== undefined
    && messageAddressing.replyTarget.author.authorId !== messageAddressing.observer.authorId
  ) {
    const target = messageAddressing.replyTarget.author;
    const evidence = explicitTargets.get(target.authorId) ?? new Set<ExplicitAddressEvidence>();
    evidence.add('reply');
    explicitTargets.set(target.authorId, evidence);
  }
  if (explicitTargets.size === 0) return { subjects: [], withheld: [] };

  const maximum = Number.isSafeInteger(input.maxSubjects) && input.maxSubjects > 0
    ? input.maxSubjects
    : 0;
  const boundedTargets = [...explicitTargets].slice(0, maximum);
  const withheld: ExplicitSubjectSelectionWithheld[] = [];
  if (explicitTargets.size > boundedTargets.length) {
    withheld.push({
      reason: 'explicit-subject-limit',
      detail: 'one or more explicit subjects were withheld before contact resolution because the turn bound was reached',
    });
  }
  const resolvedParticipants = messageAddressing.resolvedAddressee.kind === 'participants'
    ? messageAddressing.resolvedAddressee.participants
    : [];
  const explicitParticipants: {
    readonly transportParticipantId: string;
    readonly evidence: readonly ExplicitAddressEvidence[];
  }[] = [];
  for (const [transportParticipantId, evidence] of boundedTargets) {
    const participant = resolvedParticipants.find(candidate =>
      candidate.authorId === transportParticipantId);
    const expectedEvidence = [...evidence];
    if (
      participant === undefined
      || expectedEvidence.some(item => !participant.evidence.includes(item))
    ) {
      withheld.push({
        addressedParticipantId: transportParticipantId,
        reason: 'explicit-contact-missing',
        detail: 'the structured explicit target has no matching resolved participant entry',
      });
      continue;
    }
    explicitParticipants.push({ transportParticipantId, evidence: expectedEvidence });
  }
  const subjects: VerifiedExplicitSubject[] = [];
  const conflictedSubjectKeys = new Set<string>();

  for (const participant of explicitParticipants) {
    const resolution = await input.resolver.resolve({
      source: messageAddressing.source,
      transportParticipantId: participant.transportParticipantId,
      channelId: messageAddressing.channel.channelId,
      ...(messageAddressing.channel.threadId === undefined
        ? {}
        : { threadId: messageAddressing.channel.threadId }),
      evidence: participant.evidence,
    });
    if (resolution.status !== 'verified') {
      withheld.push({
        addressedParticipantId: participant.transportParticipantId,
        reason: resolution.status === 'missing'
          ? 'explicit-contact-missing'
          : 'explicit-contact-ambiguous',
        detail: resolution.status === 'missing'
          ? 'the structured participant ID has no canonical contact binding'
          : 'the structured participant ID does not resolve to exactly one canonical contact',
      });
      continue;
    }
    if (!hasValidVerifiedAuthority(resolution)) {
      withheld.push({
        addressedParticipantId: participant.transportParticipantId,
        reason: 'explicit-contact-ambiguous',
        detail: 'the canonical-contact resolver returned incomplete or invalid authority',
      });
      continue;
    }

    const subjectKey = `${resolution.subject.contactId}:${resolution.subject.subjectVersion}`;
    if (conflictedSubjectKeys.has(subjectKey)) {
      withheld.push({
        addressedParticipantId: participant.transportParticipantId,
        reason: 'explicit-contact-ambiguous',
        detail: 'structured participant IDs produced conflicting canonical-contact authority',
      });
      continue;
    }
    const duplicateIndex = subjects.findIndex(existing =>
      sameContactSubject(existing.subject, resolution.subject));
    if (duplicateIndex === -1) {
      subjects.push(resolution);
      continue;
    }
    const existing = subjects[duplicateIndex];
    if (
      existing !== undefined
      && (
        existing.trustLevel !== resolution.trustLevel
        || !sameParticipation(existing.currentParticipation, resolution.currentParticipation)
      )
    ) {
      subjects.splice(duplicateIndex, 1);
      conflictedSubjectKeys.add(subjectKey);
      withheld.push({
        addressedParticipantId: participant.transportParticipantId,
        reason: 'explicit-contact-ambiguous',
        detail: 'structured participant IDs produced conflicting canonical-contact authority',
      });
    }
  }

  return { subjects, withheld };
}
