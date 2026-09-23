// ── Due concerns follow up through per-contact outreach (psfn-framework-vcq8v.5) ──
//
// A concern about someone that reaches its review time (nextReviewAt) is the
// moment to follow up with them. Instead of a silent whisper that waits for the
// next conversation, the companion gets the same fresh per-contact outreach
// turn a social desire gets, with the concern as what is on her mind. What she
// writes is delivered through the ordinary gated outbound path carrying the
// live concern as provenance (the gate re-checks the concern is still active).
//
// Concerns never create or raise social desire (carved in social-desire.ts):
// this path runs alongside desire, sharing only the turn, routing, and gates.

import type { PostTurnActionCandidate } from '../../shared/contracts/runtime.js';
import { INTENTION_OUTBOUND_MESSAGE_ACTION_KIND, type IntentionOutboundMessageActionPayload } from './appraisal/types.js';
import type { ConcernStorePort } from './concern-store-port.js';
import { isConcernAttentionStatus, type ActiveConcern } from './concerns.js';
import { MAX_LIST_LIMIT } from './list-limit.js';
import { normalizeProactiveOutboundContent } from './proactive-outbound.js';
import { evaluateProactiveOutboundTimeGate, type ProactiveQuietHoursConfig } from './proactive-time-gate.js';
import type {
  SocialDesireConsentEvaluator,
  SocialDesireDeliveryChannel,
} from './social-desire-outreach.js';

export interface ConcernFollowUpOutreachDeps {
  concerns: Pick<ConcernStorePort, 'list' | 'transitionConcernStatus'>;
  consentEvaluator: SocialDesireConsentEvaluator;
  resolveDeliveryChannel(contactId: string): Promise<SocialDesireDeliveryChannel | null>;
  quietHours?: ProactiveQuietHoursConfig | null;
  resolveContactTimeZone?(contactId: string): Promise<string | null>;
  /** "Later" re-asks after this delay; it is also the crash-safe hold while she is asked. */
  deferDelayMs: number;
  maxPerRun: number;
  /**
   * The same per-contact pacing social outreach uses, so a contact is never
   * asked about twice inside one cooldown whichever path raised the moment.
   */
  pacing: {
    isPaced(contactId: string, nowMs: number): Promise<boolean>;
    markAsked(contactId: string, nowMs: number): Promise<void>;
  };
}

export interface ConcernFollowUpOutreachResult {
  asked: number;
  produced: Array<{
    concernId: string;
    contactId: string;
    candidate: PostTurnActionCandidate;
    channelId: string;
    channelType: SocialDesireDeliveryChannel['channelType'];
  }>;
  deferred: string[];
  declined: string[];
  blocked: Array<{ concernId: string; reason: string }>;
}

async function listDueConcerns(
  concerns: ConcernFollowUpOutreachDeps['concerns'],
  nowMs: number,
): Promise<ActiveConcern[]> {
  const due: ActiveConcern[] = [];
  for (let offset = 0; ; offset += MAX_LIST_LIMIT) {
    const batch = await concerns.list({
      includeResolved: false,
      includeExpired: false,
      limit: MAX_LIST_LIMIT,
      offset,
    });
    for (const concern of batch) {
      if (!concern.contactId || !concern.nextReviewAt || !isConcernAttentionStatus(concern.status)) continue;
      if (Date.parse(concern.nextReviewAt) <= nowMs) due.push(concern);
    }
    if (batch.length < MAX_LIST_LIMIT) break;
  }
  return due.sort((left, right) => Date.parse(left.nextReviewAt!) - Date.parse(right.nextReviewAt!));
}

async function reschedule(
  deps: ConcernFollowUpOutreachDeps,
  concern: ActiveConcern,
  nextReviewAtMs: number | null,
): Promise<void> {
  const updated = await deps.concerns.transitionConcernStatus(concern.id, {
    status: concern.status,
    ...(nextReviewAtMs === null
      ? { clearNextReview: true }
      : { nextReviewAt: new Date(nextReviewAtMs).toISOString() }),
  });
  if (!updated) throw new Error(`Concern "${concern.id}" could not be rescheduled after its follow-up moment`);
}

function buildConcernFollowUpOutboundCandidate(input: {
  concern: ActiveConcern;
  contactId: string;
  channel: SocialDesireDeliveryChannel;
  content: string;
}): PostTurnActionCandidate {
  return {
    kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
    dedupeKey: `${INTENTION_OUTBOUND_MESSAGE_ACTION_KIND}:concern-follow-up:${input.concern.id}:${input.concern.nextReviewAt ?? 'due'}`,
    payload: {
      channelId: input.channel.channelId,
      channelType: input.channel.channelType,
      content: input.content,
      reason: 'concern_follow_up',
      concernIds: [input.concern.id],
      appraisalFollowUp: {
        channelId: input.channel.channelId,
        canonicalContactKey: input.contactId,
      },
    } satisfies IntentionOutboundMessageActionPayload,
    maxRetries: 1,
  };
}

export async function runConcernFollowUpOutreachOnce(
  deps: ConcernFollowUpOutreachDeps,
  nowMs: number,
): Promise<ConcernFollowUpOutreachResult> {
  const result: ConcernFollowUpOutreachResult = {
    asked: 0, produced: [], deferred: [], declined: [], blocked: [],
  };
  const budget = Math.max(1, Math.floor(deps.maxPerRun));
  for (const concern of await listDueConcerns(deps.concerns, nowMs)) {
    if (result.asked >= budget) break;
    const contactId = concern.contactId!;
    const timeGate = evaluateProactiveOutboundTimeGate({
      nowMs,
      quietHours: deps.quietHours ?? null,
      contactTimeZone: deps.resolveContactTimeZone ? await deps.resolveContactTimeZone(contactId) : null,
    });
    if (!timeGate.allowed) continue;
    if (await deps.pacing.isPaced(contactId, nowMs)) continue;
    const channel = await deps.resolveDeliveryChannel(contactId);
    if (!channel) {
      // No private route to this person: nothing to follow up through, so the
      // concern stops asking (it stays a live concern for conversation).
      await reschedule(deps, concern, null);
      result.blocked.push({ concernId: concern.id, reason: 'no_delivery_channel' });
      continue;
    }
    result.asked += 1;
    // Durable hold before the turn so a crash cannot re-ask immediately.
    await reschedule(deps, concern, nowMs + deps.deferDelayMs);
    await deps.pacing.markAsked(contactId, nowMs);
    const decision = await deps.consentEvaluator.evaluate({
      contactId,
      ...(channel.contactName ? { contactName: channel.contactName } : {}),
      orientation: 'warm',
      pressure: { warm: 0, repair: 0, total: 0, dominantOrientation: 'warm' },
      channelId: channel.channelId,
      channelType: channel.channelType,
      companionTarget: channel.companionTarget,
      reason: `You meant to follow up with them about this: ${concern.text}`,
    });
    if (decision.action === 'defer') {
      result.deferred.push(concern.id);
      continue;
    }
    const content = decision.action === 'message' ? normalizeProactiveOutboundContent(decision.content) : '';
    await reschedule(deps, concern, null);
    if (!content) {
      result.declined.push(concern.id);
      continue;
    }
    result.produced.push({
      concernId: concern.id,
      contactId,
      candidate: buildConcernFollowUpOutboundCandidate({ concern, contactId, channel, content }),
      channelId: channel.channelId,
      channelType: channel.channelType,
    });
  }
  return result;
}
