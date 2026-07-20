// ── Social-desire consent moment and outbound provenance (epic oth4, bead oth4.2) ──
//
// The consent side of the per-contact durable social desire (oth4.1). When an
// eligible desire crosses threshold, the companion gets a CONSENT MOMENT — an
// LLM re-evaluation where she chooses message / defer / decline. Nothing here
// ever auto-sends: an accepted consent only mints a single-use consent record
// and emits an INTENTION_OUTBOUND_MESSAGE post-turn action carrying
// social-desire provenance. Delivery rides the EXISTING durable-outbox handler
// (provenance gate, terminal dedupe, ICP candidate broker, quiet-hours gate,
// ProactiveOutboundDispatcher policy + rate limits all unchanged).
//
// Everything before the consent moment is DETERMINISTIC and zero-LLM: tier
// re-resolution, threshold/cooling-off/quiet-hours eligibility (quiet hours
// checked last by the primitive, so no LLM ever fires inside the window), the
// tight outbound rate budget, and delivery-channel resolution all run first.
//
// Consent lifecycle (single-use, this-moment-only):
// - `message` mints a consent bound to {contactId, orientation, action dedupe};
//   the outbound gate verifies it against this ledger and the desire store, and
//   it is consumed on the action's terminal disposition. Pressure is released
//   only on successful dispatch (or delivered ICP candidate) — never here.
// - `defer` / `decline` apply the primitive's dampening (pressure drops toward,
//   never to, zero) and send nothing.
// - Restart or TTL expiry invalidates unconsumed consents: the moment has
//   passed, so the gate fails closed and a fresh consent moment is required.
//
// Negative-origin (repair) desires get the SAME choice set — she may want an
// apology or an explanation, or to cool off longer (parent addendum).

import { createHash, randomUUID } from 'node:crypto';
import type {
  ChannelType,
  InferredPostTurnAction,
  PostTurnActionCandidate,
} from '../../shared/contracts/runtime.js';
import type { ProactiveQuietHoursConfig } from './proactive-time-gate.js';
import { normalizeProactiveOutboundContent } from './proactive-outbound.js';
import { stableStringify } from './appraisal/shared.js';
import {
  INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
  type IntentionOutboundMessageActionPayload,
} from './appraisal/types.js';
import {
  applySocialDesireDampening,
  decayedSocialDesirePressure,
  evaluateSocialDesireEligibility,
  type SocialDesireIneligibilityReason,
  type SocialDesireLifecycleConfig,
  type SocialDesireOrientation,
  type SocialDesirePressureView,
} from './social-desire.js';
import type {
  SocialDesireRelationshipTierSource,
  SocialDesireStorePort,
} from './social-desire-store-port.js';

// ── Consent decision ──

export type SocialDesireConsentDecision =
  /** She wants to reach out now, with this message. */
  | { action: 'message'; content: string }
  /** Not now — let it wait and keep the desire (dampened) for later. */
  | { action: 'defer'; reason?: string }
  /** She does not want to act on this desire (dampened, may rebuild). */
  | { action: 'decline'; reason?: string };

export const SOCIAL_DESIRE_CONSENT_ACTIONS = ['message', 'defer', 'decline'] as const;

export interface SocialDesireConsentEvaluationInput {
  contactId: string;
  contactName?: string;
  /** Dominant orientation of the decayed pressure (warm | repair). */
  orientation: SocialDesireOrientation;
  pressure: SocialDesirePressureView;
  lastWarmFeltAt?: string;
  lastRepairFeltAt?: string;
  channelId: string;
  channelType: ChannelType;
  /** True when the target contact is another companion (ICP candidate path). */
  companionTarget: boolean;
}

/**
 * The consent moment. Production wires this to an LLM call that presents the
 * desire (contact, orientation, felt basis) and lets the companion choose
 * message / defer / decline; tests inject fakes. Called ONLY after every
 * deterministic pre-check passed.
 */
export interface SocialDesireConsentEvaluator {
  evaluate(input: SocialDesireConsentEvaluationInput): Promise<SocialDesireConsentDecision>;
}

// ── Consent ledger ──

export interface SocialDesireConsentRecord {
  consentId: string;
  contactId: string;
  orientation: SocialDesireOrientation;
  issuedAtMs: number;
  expiresAtMs: number;
  binding?: SocialDesireConsentBinding;
}

export interface SocialDesireConsentBinding {
  actionId: string;
  dedupeKey: string;
  channelId: string;
  channelType: ChannelType;
  content: string;
  orientation: SocialDesireOrientation;
  reason: string;
  /** Hash of the complete normalized durable action, including its full payload. */
  actionFingerprint: string;
}

export function fingerprintSocialDesireOutboundAction(action: InferredPostTurnAction): string {
  return createHash('sha256').update(stableStringify({
    id: action.id,
    kind: action.kind,
    payload: action.payload,
    dedupeKey: action.dedupeKey,
    channelId: action.channelId,
    sourceMessageId: action.sourceMessageId,
    inferredAt: action.inferredAt,
    maxRetries: action.maxRetries ?? null,
    runAt: action.runAt ?? null,
  })).digest('hex');
}

export interface SocialDesireConsentVerification extends SocialDesireConsentBinding {
  consentId: string;
  contactId: string;
  nowMs: number;
}

/**
 * Single-use, TTL-bound registry of accepted consents. Deliberately in-memory:
 * a consent belongs to the moment it was given, so a restart (or TTL expiry)
 * invalidates it and the outbound gate fails closed until a fresh consent
 * moment happens. Nothing can mint a verifiable consent except `issue`.
 */
export interface SocialDesireConsentLedger {
  issue(input: {
    contactId: string;
    orientation: SocialDesireOrientation;
    nowMs: number;
  }): SocialDesireConsentRecord;
  /** Bind once to the exact normalized durable action that may spend it. */
  bind(consentId: string, binding: SocialDesireConsentBinding): SocialDesireConsentRecord;
  /** Live consent whose complete action capability matches exactly, or null. */
  verify(input: SocialDesireConsentVerification): SocialDesireConsentRecord | null;
  /** Marks the consent spent. Consuming twice or consuming unknown ids is a no-op. */
  consume(consentId: string): void;
  /** Cancel an accepted moment whose durable action could not be enqueued. */
  revoke(consentId: string): void;
  /** True when the contact has a live consent (an in-flight outbound action). */
  hasLiveConsentForContact(contactId: string, nowMs: number): boolean;
}

export function createSocialDesireConsentLedger(options: { ttlMs: number }): SocialDesireConsentLedger {
  if (!(options.ttlMs > 0)) {
    throw new Error('Social desire consent ledger requires a positive ttlMs');
  }
  const consents = new Map<string, SocialDesireConsentRecord & { consumed: boolean }>();

  const prune = (nowMs: number): void => {
    for (const [id, record] of consents) {
      if (record.consumed || record.expiresAtMs <= nowMs) {
        consents.delete(id);
      }
    }
  };

  return {
    issue: ({ contactId, orientation, nowMs }) => {
      const normalizedContactId = contactId.trim();
      if (!normalizedContactId) {
        throw new Error('Social desire consent requires a contactId');
      }
      prune(nowMs);
      const record: SocialDesireConsentRecord = {
        consentId: randomUUID(),
        contactId: normalizedContactId,
        orientation,
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + options.ttlMs,
      };
      consents.set(record.consentId, { ...record, consumed: false });
      return record;
    },
    bind: (consentId, binding) => {
      const record = consents.get(consentId);
      if (!record || record.consumed) {
        throw new Error('Cannot bind an unknown or consumed social desire consent');
      }
      if (record.binding) {
        throw new Error('Social desire consent is already bound to an action');
      }
      const normalized: SocialDesireConsentBinding = {
        actionId: binding.actionId.trim(),
        dedupeKey: binding.dedupeKey.trim(),
        channelId: binding.channelId.trim(),
        channelType: binding.channelType,
        content: normalizeProactiveOutboundContent(binding.content),
        orientation: binding.orientation,
        reason: binding.reason.trim(),
        actionFingerprint: binding.actionFingerprint.trim(),
      };
      if (!normalized.actionId || !normalized.dedupeKey || !normalized.channelId
        || !normalized.content || !normalized.reason || !normalized.actionFingerprint
        || normalized.orientation !== record.orientation) {
        throw new Error('Social desire consent action binding is invalid');
      }
      record.binding = normalized;
      const { consumed: _consumed, ...view } = record;
      return { ...view, binding: { ...normalized } };
    },
    verify: (input) => {
      const record = consents.get(input.consentId);
      if (!record || record.consumed || record.expiresAtMs <= input.nowMs || !record.binding) {
        return null;
      }
      const binding = record.binding;
      if (record.contactId !== input.contactId.trim()
        || binding.actionId !== input.actionId.trim()
        || binding.dedupeKey !== input.dedupeKey.trim()
        || binding.channelId !== input.channelId.trim()
        || binding.channelType !== input.channelType
        || binding.content !== normalizeProactiveOutboundContent(input.content)
        || binding.orientation !== input.orientation
        || binding.reason !== input.reason.trim()
        || binding.actionFingerprint !== input.actionFingerprint.trim()) {
        return null;
      }
      const { consumed: _consumed, ...view } = record;
      return { ...view, binding: { ...binding } };
    },
    consume: (consentId) => {
      const record = consents.get(consentId);
      if (record) {
        record.consumed = true;
      }
    },
    revoke: (consentId) => {
      consents.delete(consentId);
    },
    hasLiveConsentForContact: (contactId, nowMs) => {
      const normalized = contactId.trim();
      for (const record of consents.values()) {
        if (!record.consumed && record.expiresAtMs > nowMs && record.contactId === normalized) {
          return true;
        }
      }
      return false;
    },
  };
}

// ── Outbound provenance ──

/** Social-desire provenance carried on an INTENTION_OUTBOUND_MESSAGE payload. */
export interface SocialDesireOutboundProvenance {
  /** The desire record id (contactId — desires coalesce one-per-contact). */
  contactId: string;
  /** Single-use consent minted by the consent moment; verified at the gate. */
  consentId: string;
  orientation: SocialDesireOrientation;
}

export function buildSocialDesireOutboundCandidate(input: {
  consent: SocialDesireConsentRecord;
  content: string;
  channelId: string;
  channelType: ChannelType;
}): PostTurnActionCandidate {
  const { consent, content, channelId, channelType } = input;
  return {
    kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
    // The consentId is unique per accepted moment, so the dedupe key binds the
    // action 1:1 to this consent: the durable outbox terminal-replay guard
    // makes "dispatch exactly once" structural.
    dedupeKey: `${INTENTION_OUTBOUND_MESSAGE_ACTION_KIND}:social-desire:${consent.contactId}:${consent.consentId}`,
    payload: {
      channelId,
      channelType,
      content,
      reason: `social_desire:${consent.orientation}`,
      socialDesire: {
        contactId: consent.contactId,
        consentId: consent.consentId,
        orientation: consent.orientation,
      },
    } satisfies IntentionOutboundMessageActionPayload,
    maxRetries: 1,
  };
}

// ── Outbound runtime (gate-side port) ──

export interface SocialDesireOutboundBudgetConfig {
  /** Maximum desire-driven sends across ALL contacts per rolling window. */
  maxSendsPerWindow: number;
  windowMs: number;
}

/**
 * The narrow surface the heartbeat outbound handler needs to accept consented
 * social-desire provenance. Wired in composition ONLY when socialDesire.enabled
 * is true — its absence makes the gate fail closed for any social-desire
 * payload (the whole lane is inert when disabled).
 */
export interface SocialDesireOutboundRuntime {
  verifyConsent(input: SocialDesireConsentVerification): boolean;
  consumeConsent(consentId: string): void;
  hasDesire(contactId: string): Promise<boolean>;
  /** Deterministic budget check over the durable send ledger plus local reservations. */
  isBudgetExhausted(nowMs: number, reservedSendCount?: number): boolean;
  budget: SocialDesireOutboundBudgetConfig;
  /** Atomically apply a terminal outcome once under its durable action identity. */
  settle(input: {
    settlementId: string;
    contactId: string;
    disposition: 'sent' | 'terminal_block';
    nowMs: number;
  }): Promise<'released' | 'dampened' | 'already_settled' | 'missing'>;
}

export function createSocialDesireOutboundRuntime(options: {
  store: Pick<SocialDesireStorePort, 'getByContactId' | 'settle'>;
  lifecycle: SocialDesireLifecycleConfig;
  consents: SocialDesireConsentLedger;
  budget: SocialDesireOutboundBudgetConfig;
  /** Durable count of desire-driven sends since `sinceMs` (outreach outbox). */
  countRecentSends(sinceMs: number): number;
}): SocialDesireOutboundRuntime {
  if (!(options.budget.maxSendsPerWindow >= 1) || !Number.isFinite(options.budget.maxSendsPerWindow)) {
    throw new Error('Social desire outbound budget requires maxSendsPerWindow >= 1');
  }
  if (!(options.budget.windowMs > 0)) {
    throw new Error('Social desire outbound budget requires a positive windowMs');
  }
  const isBudgetExhausted = (nowMs: number, reservedSendCount = 0): boolean => {
    if (!Number.isSafeInteger(reservedSendCount) || reservedSendCount < 0) {
      throw new Error('Social desire outbound budget requires a non-negative reservedSendCount');
    }
    return options.countRecentSends(nowMs - options.budget.windowMs) + reservedSendCount
      >= Math.floor(options.budget.maxSendsPerWindow);
  };
  return {
    verifyConsent: (input) => options.consents.verify(input) !== null,
    consumeConsent: (consentId) => options.consents.consume(consentId),
    hasDesire: async (contactId) => (await options.store.getByContactId(contactId)) !== null,
    isBudgetExhausted,
    budget: { ...options.budget },
    settle: async (input) => options.store.settle({ ...input, lifecycle: options.lifecycle }),
  };
}

// ── Consent-moment run (scheduler lane core) ──

export interface SocialDesireDeliveryChannel {
  channelId: string;
  channelType: ChannelType;
  contactName?: string;
  /** True when the contact is a peer companion (routes as an ICP candidate). */
  companionTarget: boolean;
}

export interface SocialDesireOutreachDeps {
  store: SocialDesireStorePort;
  lifecycle: SocialDesireLifecycleConfig;
  /** Live tier re-resolution — tier changes flip eligibility immediately. */
  tierSource: SocialDesireRelationshipTierSource;
  consentEvaluator: SocialDesireConsentEvaluator;
  consents: SocialDesireConsentLedger;
  /** Cap on LLM consent moments per run (usually 1). */
  maxConsentMomentsPerRun: number;
  quietHours?: ProactiveQuietHoursConfig | null;
  /** Recipient timezone lookup for quiet-hours evaluation (Contact.timezone). */
  resolveContactTimeZone?(contactId: string): Promise<string | null>;
  /**
   * Fail-closed delivery-channel resolution. Null means no policy-approved
   * channel exists for this contact; the desire stays pressurized and no
   * consent moment happens.
   */
  resolveDeliveryChannel(contactId: string): Promise<SocialDesireDeliveryChannel | null>;
  /** Deterministic budget pre-check including accepted messages reserved by this run. */
  isBudgetExhausted(nowMs: number, reservedConsentCount: number): boolean;
}

export interface SocialDesireOutreachRunResult {
  desiresEvaluated: number;
  /** Number of LLM consent moments that actually ran. */
  consentMomentsEvaluated: number;
  produced: Array<{
    contactId: string;
    orientation: SocialDesireOrientation;
    consentId: string;
    pressureTotal: number;
    candidate: PostTurnActionCandidate;
    channelId: string;
    channelType: ChannelType;
    companionTarget: boolean;
  }>;
  deferred: Array<{ contactId: string; reason?: string; dampenedPressure: number }>;
  declined: Array<{ contactId: string; reason?: string; dampenedPressure: number }>;
  blocked: Array<{ contactId: string; reason: string }>;
  skipped: Array<{
    contactId: string;
    reason: SocialDesireIneligibilityReason | 'budget_exhausted' | 'consent_pending';
    nextEligibleAtMs?: number;
  }>;
}

/**
 * Evaluate durable social desires once and produce outbound action candidates
 * for accepted consents. Pure orchestration over injected ports — no bus, no
 * scheduler — so it is directly testable. Emits nothing and sends nothing; the
 * scheduler wrapper turns the result into typed events and enqueues candidates
 * through the standard post-turn action path.
 */
export async function runSocialDesireOutreachOnce(
  deps: SocialDesireOutreachDeps,
  nowMs: number,
): Promise<SocialDesireOutreachRunResult> {
  const result: SocialDesireOutreachRunResult = {
    desiresEvaluated: 0,
    consentMomentsEvaluated: 0,
    produced: [],
    deferred: [],
    declined: [],
    blocked: [],
    skipped: [],
  };
  const consentBudget = Math.max(1, Math.floor(deps.maxConsentMomentsPerRun));

  // Strongest desires first, so the per-run consent cap goes to the desire
  // with the most accumulated pressure.
  const desires = deps.store.snapshotDesires()
    .map(desire => ({ desire, pressure: decayedSocialDesirePressure(desire, deps.lifecycle, nowMs) }))
    .sort((a, b) => b.pressure.total - a.pressure.total);

  for (const { desire, pressure } of desires) {
    if (result.consentMomentsEvaluated >= consentBudget) break;
    result.desiresEvaluated += 1;
    const contactId = desire.contactId;

    // An unconsumed live consent means an outbound action is already in
    // flight for this contact — never stack a second consent moment on it.
    if (deps.consents.hasLiveConsentForContact(contactId, nowMs)) {
      result.skipped.push({ contactId, reason: 'consent_pending' });
      continue;
    }

    // 1. Deterministic eligibility: live tier, threshold, cooling-off, quiet
    //    hours (checked last by the primitive — no LLM inside the window).
    const relationshipType = await deps.tierSource.resolveRelationshipTier(contactId);
    const contactTimeZone = deps.resolveContactTimeZone
      ? await deps.resolveContactTimeZone(contactId)
      : null;
    const eligibility = evaluateSocialDesireEligibility(
      {
        desire,
        relationshipType,
        nowMs,
        quietHours: deps.quietHours ?? null,
        contactTimeZone,
      },
      deps.lifecycle,
    );
    if (!eligibility.eligible) {
      result.skipped.push({
        contactId,
        reason: eligibility.reason,
        ...(eligibility.nextEligibleAtMs !== undefined
          ? { nextEligibleAtMs: eligibility.nextEligibleAtMs }
          : {}),
      });
      continue;
    }

    // 2. Deterministic rate budget (still zero LLM). The desire keeps its
    //    pressure untouched and simply retries on a later run.
    if (deps.isBudgetExhausted(nowMs, result.produced.length)) {
      result.skipped.push({ contactId, reason: 'budget_exhausted' });
      continue;
    }

    // 3. Deterministic, fail-closed delivery-channel resolution.
    const channel = await deps.resolveDeliveryChannel(contactId);
    if (!channel) {
      result.blocked.push({ contactId, reason: 'no_delivery_channel' });
      continue;
    }

    // 4. The consent moment (LLM). Message, defer, or decline — never auto-send.
    result.consentMomentsEvaluated += 1;
    const decision = await deps.consentEvaluator.evaluate({
      contactId,
      ...(channel.contactName ? { contactName: channel.contactName } : {}),
      orientation: eligibility.pressure.dominantOrientation,
      pressure: eligibility.pressure,
      ...(desire.lastWarmFeltAt ? { lastWarmFeltAt: desire.lastWarmFeltAt } : {}),
      ...(desire.lastRepairFeltAt ? { lastRepairFeltAt: desire.lastRepairFeltAt } : {}),
      channelId: channel.channelId,
      channelType: channel.channelType,
      companionTarget: channel.companionTarget,
    });

    if (decision.action === 'message') {
      const content = normalizeProactiveOutboundContent(decision.content);
      if (!content) {
        // An accept with blank content cannot form an outbound message.
        // Dampen so the desire defers instead of re-burning consent moments.
        const dampened = applySocialDesireDampening(desire, deps.lifecycle, nowMs);
        await deps.store.save(dampened);
        result.blocked.push({ contactId, reason: 'empty_consent_content' });
        continue;
      }
      const consent = deps.consents.issue({
        contactId,
        orientation: eligibility.pressure.dominantOrientation,
        nowMs,
      });
      result.produced.push({
        contactId,
        orientation: consent.orientation,
        consentId: consent.consentId,
        pressureTotal: pressure.total,
        candidate: buildSocialDesireOutboundCandidate({
          consent,
          content,
          channelId: channel.channelId,
          channelType: channel.channelType,
        }),
        channelId: channel.channelId,
        channelType: channel.channelType,
        companionTarget: channel.companionTarget,
      });
      continue;
    }

    // Defer/decline: dampen (kept, not zeroed) and send nothing.
    const dampened = applySocialDesireDampening(desire, deps.lifecycle, nowMs);
    await deps.store.save(dampened);
    const entry = {
      contactId,
      ...(decision.reason ? { reason: decision.reason } : {}),
      dampenedPressure: decayedSocialDesirePressure(dampened, deps.lifecycle, nowMs).total,
    };
    if (decision.action === 'defer') {
      result.deferred.push(entry);
    } else {
      result.declined.push(entry);
    }
  }

  return result;
}
