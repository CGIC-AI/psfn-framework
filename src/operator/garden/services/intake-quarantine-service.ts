// ── Garden intake quarantine approval service (htm9.11) ──
//
// The operator-facing release/discard surface over the durable intake
// quarantine store. Releasing quarantined content is the single most
// dangerous operator action in the firewall (a wrong release hands hostile
// content to the companion), so every decision is enforced SERVER-SIDE with a
// two-step confirm-token flow — the UI's double-confirm is presentation, not
// the guarantee:
//
//   1. beginDecision(...)  → issues a single-use confirm token, short TTL
//      (~2 min), bound to the specific entry, decision action, flywheel
//      option, AND content hash, plus a fingerprint of the current
//      intake-policy source lists.
//   2. resolveDecision(...) → consumes the token (single-use even on
//      failure), re-validates every binding, and rejects if the source lists
//      changed in between (fail closed: a policy change invalidates every
//      outstanding confirmation).
//
// Tokens only mint through this service, which is only reachable through the
// operator-authenticated /api/admin surface — that binding is the operator
// capability enforcement (no in-process caller can release without a token).
//
// THE FLYWHEEL: a decision may carry always-allow / always-deny-this-source,
// persisted into the intake-policy sourceLists through the EXISTING owner-file
// mutation path (settings service → applyIntakeSourceListMutation), so the
// same class of item stops escalating. No second list mechanism exists.
//
// Every resolution writes a CogSecEvent (applying → applied/failed) in
// addition to the Garden audit-timeline entry the route emits.

import { createHash, randomBytes } from 'node:crypto';
import type {
  CogSecEventStore,
  CogSecSeverity,
} from '../../../core/cogsec/events.js';
import type {
  IntakeQuarantineDecisionAction,
  IntakeQuarantineEntry,
  IntakeQuarantineStore,
} from '../../../core/cogsec/intake/quarantine-store.js';
import { extractHostFromOriginRef } from '../../../core/cogsec/intake/source-lists.js';
import type { IntakeSourceListName } from '../../../system/config/intake-policy-config.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { AdminSettingsService } from './types/settings.js';

export const INTAKE_QUARANTINE_SOURCE_LIST_ACTIONS = ['always_allow', 'always_deny'] as const;
export type AdminIntakeQuarantineSourceListAction =
  typeof INTAKE_QUARANTINE_SOURCE_LIST_ACTIONS[number];

export function isAdminIntakeQuarantineSourceListAction(
  value: unknown,
): value is AdminIntakeQuarantineSourceListAction {
  return typeof value === 'string'
    && (INTAKE_QUARANTINE_SOURCE_LIST_ACTIONS as readonly string[]).includes(value);
}

/** Site host or canonical contact id the flywheel option would list. */
export interface AdminIntakeQuarantineFlywheelTarget {
  kind: 'site' | 'person';
  pattern: string;
}

export interface AdminIntakeQuarantineItemView {
  id: string;
  status: IntakeQuarantineEntry['status'];
  /** Firewall mode at hold time; shadow items were delivered, not withheld. */
  mode: 'shadow' | 'enforce';
  sourceClass: string;
  sourceRiskTier: string;
  originRef: string;
  originDetail?: string;
  canonicalContactId?: string;
  riskLabels: string[];
  /** Calibrated 0-1 scores keyed by scanner/classifier id (which classifiers fired). */
  scores: Record<string, number>;
  /** Screening decision that quarantined the item, verbatim. */
  screeningDecisionReason?: string;
  heldAt: string;
  expiresAt: string;
  /** Milliseconds until TTL expiry; 0 for non-held entries. */
  ttlRemainingMs: number;
  contentSha256?: string;
  contentSizeBytes?: number;
  rawTextTruncated: boolean;
  /** False ⇒ release_sanitized is unavailable for this item (explicit). */
  safeRepresentationAvailable: boolean;
  /** L3 safe-representation highlights when the item went through L3. */
  summary?: string;
  whyFlagged?: string;
  cogSecCaseId?: string;
  operatorDecision?: {
    action: IntakeQuarantineDecisionAction;
    actor: string;
    reason: string;
    at: string;
  };
  /** What always-allow/always-deny would list; null when underivable. */
  flywheelTarget: AdminIntakeQuarantineFlywheelTarget | null;
}

export interface AdminIntakeQuarantineItemDetail extends AdminIntakeQuarantineItemView {
  /** Raw held content (operator console only; scrubbed after discard/expire). */
  rawText: string;
  safeRepresentationText?: string;
  extractedFields: Record<string, string>;
  transitions: Array<{
    from: string;
    to: string;
    at: string;
    actor: string;
    reason: string;
  }>;
}

export interface AdminIntakeQuarantineDecisionRequest {
  id: string;
  action: IntakeQuarantineDecisionAction;
  sourceList?: AdminIntakeQuarantineSourceListAction;
}

export type AdminIntakeQuarantineBeginResult =
  | { ok: true; confirmToken: string; expiresAtMs: number; summary: string }
  | { ok: false; status: number; message: string };

export type AdminIntakeQuarantineResolveResult =
  | { ok: true; item: AdminIntakeQuarantineItemView; message: string; cogSecCaseId: string }
  | { ok: false; status: number; message: string };

export interface AdminIntakeQuarantineService {
  listItems(): { items: AdminIntakeQuarantineItemView[] };
  getItem(id: string): AdminIntakeQuarantineItemDetail | undefined;
  /** Step 1 of the server-side double-confirm: issue the confirm token. */
  beginDecision(request: AdminIntakeQuarantineDecisionRequest): AdminIntakeQuarantineBeginResult;
  /** Step 2: consume the token and execute the decision. */
  resolveDecision(
    request: AdminIntakeQuarantineDecisionRequest & { confirmToken: string; reason: string },
  ): AdminIntakeQuarantineResolveResult;
}

export interface AdminIntakeQuarantineServiceDeps {
  store: IntakeQuarantineStore;
  settingsService: Pick<AdminSettingsService, 'getIntakeSourceLists' | 'mutateIntakeSourceList'>;
  /**
   * Provider (not instance): CogSecEventStore snapshots the file at
   * construction, and the gateway writes the same file concurrently — a
   * fresh store per decision keeps the stale-clobber window to the decision
   * itself instead of the whole Garden process lifetime.
   */
  cogSecEvents: () => Pick<CogSecEventStore, 'createEvent' | 'updateEvent'>;
  now?: () => number;
  /** Confirm-token lifetime; default 2 minutes. */
  confirmTokenTtlMs?: number;
}

const DEFAULT_CONFIRM_TOKEN_TTL_MS = 2 * 60_000;
const OPERATOR_ACTOR = 'operator:garden';
const MAX_REASON_CHARS = 1024;

interface PendingConfirmToken {
  token: string;
  action: IntakeQuarantineDecisionAction;
  sourceList?: AdminIntakeQuarantineSourceListAction;
  contentSha256?: string;
  sourceListsFingerprint: string;
  expiresAtMs: number;
}

function deriveFlywheelTarget(
  entry: IntakeQuarantineEntry,
): AdminIntakeQuarantineFlywheelTarget | null {
  // Envelope validation guarantees at least the origin hop.
  const originHop = entry.envelope.provenance[0];
  const host = extractHostFromOriginRef(originHop.ref);
  if (host) return { kind: 'site', pattern: host };
  if (entry.canonicalContactId?.trim()) {
    return { kind: 'person', pattern: entry.canonicalContactId.trim() };
  }
  return null;
}

function flywheelListFor(
  target: AdminIntakeQuarantineFlywheelTarget,
  action: AdminIntakeQuarantineSourceListAction,
): IntakeSourceListName {
  if (target.kind === 'site') {
    return action === 'always_allow' ? 'trustedSites' : 'deniedSites';
  }
  return action === 'always_allow' ? 'trustedPeople' : 'deniedPeople';
}

function toIso(atMs: number): string {
  return new Date(atMs).toISOString();
}

function toItemView(entry: IntakeQuarantineEntry, nowMs: number): AdminIntakeQuarantineItemView {
  // Envelope validation guarantees at least the origin hop.
  const originHop = entry.envelope.provenance[0];
  const fields = entry.envelope.extractedFields;
  // Extracted fields are an open record; these keys may be absent.
  const extractedField = (key: string): string | undefined => (
    Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined
  );
  const l3Summary = extractedField('l3_summary');
  const l3WhyFlagged = extractedField('l3_why_flagged');
  return {
    id: entry.id,
    status: entry.status,
    mode: entry.mode,
    sourceClass: entry.envelope.sourceClass,
    sourceRiskTier: entry.envelope.sourceRiskTier,
    originRef: originHop.ref,
    ...(originHop.detail !== undefined ? { originDetail: originHop.detail } : {}),
    ...(entry.canonicalContactId !== undefined
      ? { canonicalContactId: entry.canonicalContactId }
      : {}),
    riskLabels: [...entry.envelope.riskLabels],
    scores: { ...entry.envelope.scores },
    ...(entry.envelope.decision ? { screeningDecisionReason: entry.envelope.decision.reason } : {}),
    heldAt: toIso(entry.heldAtMs),
    expiresAt: toIso(entry.expiresAtMs),
    ttlRemainingMs: entry.status === 'held' ? Math.max(0, entry.expiresAtMs - nowMs) : 0,
    ...(entry.envelope.contentRef.sha256 !== undefined
      ? { contentSha256: entry.envelope.contentRef.sha256 }
      : {}),
    ...(entry.envelope.contentRef.sizeBytes !== undefined
      ? { contentSizeBytes: entry.envelope.contentRef.sizeBytes }
      : {}),
    rawTextTruncated: entry.rawTextTruncated,
    safeRepresentationAvailable: Boolean(entry.safeRepresentationText),
    ...(l3Summary !== undefined ? { summary: l3Summary } : {}),
    ...(l3WhyFlagged !== undefined ? { whyFlagged: l3WhyFlagged } : {}),
    ...(entry.cogSecCaseId !== undefined ? { cogSecCaseId: entry.cogSecCaseId } : {}),
    ...(entry.decision
      ? {
        operatorDecision: {
          action: entry.decision.action,
          actor: entry.decision.actor,
          reason: entry.decision.reason,
          at: toIso(entry.decision.atMs),
        },
      }
      : {}),
    flywheelTarget: deriveFlywheelTarget(entry),
  };
}

const DECISION_LABELS: Record<IntakeQuarantineDecisionAction, string> = {
  release_raw: 'release the RAW held content',
  release_sanitized: 'release the neutral safe representation',
  discard: 'discard the held content',
};

export function createAdminIntakeQuarantineService(
  deps: AdminIntakeQuarantineServiceDeps,
): AdminIntakeQuarantineService {
  const now = deps.now ?? Date.now;
  const tokenTtlMs = deps.confirmTokenTtlMs ?? DEFAULT_CONFIRM_TOKEN_TTL_MS;
  // One outstanding confirmation per entry; a new begin replaces the old one.
  const pendingConfirms = new Map<string, PendingConfirmToken>();

  /**
   * Canonical fingerprint of the current source lists. Captured at token
   * issuance and re-checked at resolution: ANY source-list change in between
   * invalidates the confirmation (a strict superset of "any change to that
   * source" — fail closed).
   */
  const sourceListsFingerprint = (): string => {
    const lists = deps.settingsService.getIntakeSourceLists();
    const canonical = (['trustedSites', 'deniedSites', 'trustedPeople', 'deniedPeople'] as const)
      .map((name) => `${name}:${lists[name].map((entry) => entry.pattern).sort().join(',')}`)
      .join(';');
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  };

  const validateRequestShape = (
    request: AdminIntakeQuarantineDecisionRequest,
    entry: IntakeQuarantineEntry,
  ): { ok: true; target: AdminIntakeQuarantineFlywheelTarget | null } | { ok: false; status: number; message: string } => {
    if (entry.status !== 'held') {
      return {
        ok: false,
        status: 409,
        message: `Quarantine item is '${entry.status}', not held; no decision can be taken`,
      };
    }
    if (request.action === 'release_sanitized' && !entry.safeRepresentationText) {
      return {
        ok: false,
        status: 409,
        message: 'This item has no safe representation (it predates L3 or L3 produced none); '
          + 'release-sanitized is unavailable — release raw or discard instead',
      };
    }
    const target = deriveFlywheelTarget(entry);
    if (request.sourceList && !target) {
      return {
        ok: false,
        status: 400,
        message: 'This item has no listable source (no URL host and no canonical contact id); '
          + 'always-allow/always-deny is unavailable for it',
      };
    }
    return { ok: true, target };
  };

  return {
    listItems() {
      const nowMs = now();
      return { items: deps.store.list().map((entry) => toItemView(entry, nowMs)) };
    },

    getItem(id: string): AdminIntakeQuarantineItemDetail | undefined {
      const entry = deps.store.getById(id);
      if (!entry) return undefined;
      return {
        ...toItemView(entry, now()),
        rawText: entry.rawText,
        ...(entry.safeRepresentationText !== undefined
          ? { safeRepresentationText: entry.safeRepresentationText }
          : {}),
        extractedFields: { ...entry.envelope.extractedFields },
        transitions: entry.envelope.transitions.map((record) => ({
          from: record.from,
          to: record.to,
          at: toIso(record.atMs),
          actor: record.actor,
          reason: record.reason,
        })),
      };
    },

    beginDecision(request): AdminIntakeQuarantineBeginResult {
      const entry = deps.store.getById(request.id);
      if (!entry) {
        return { ok: false, status: 404, message: `Quarantine item not found: ${request.id}` };
      }
      const validated = validateRequestShape(request, entry);
      if (!validated.ok) return validated;

      const atMs = now();
      const token = randomBytes(32).toString('hex');
      pendingConfirms.set(entry.id, {
        token,
        action: request.action,
        ...(request.sourceList !== undefined ? { sourceList: request.sourceList } : {}),
        ...(entry.envelope.contentRef.sha256 !== undefined
          ? { contentSha256: entry.envelope.contentRef.sha256 }
          : {}),
        sourceListsFingerprint: sourceListsFingerprint(),
        expiresAtMs: atMs + tokenTtlMs,
      });

      const flywheelNote = request.sourceList && validated.target
        ? ` and ${request.sourceList === 'always_allow' ? 'always-allow' : 'always-deny'} `
          + `${validated.target.kind} '${validated.target.pattern}' `
          + `(persists into intake-policy sourceLists)`
        : '';
      return {
        ok: true,
        confirmToken: token,
        expiresAtMs: atMs + tokenTtlMs,
        summary: `This will ${DECISION_LABELS[request.action]} for ${entry.envelope.sourceClass} `
          + `item ${entry.id}${flywheelNote}. `
          + 'The decision is irreversible and fully audited.',
      };
    },

    resolveDecision(request): AdminIntakeQuarantineResolveResult {
      const reason = request.reason.trim();
      if (!reason || reason.length > MAX_REASON_CHARS) {
        return {
          ok: false,
          status: 400,
          message: `A non-empty reason of at most ${String(MAX_REASON_CHARS)} characters is required`,
        };
      }

      // ── Confirm-token gate (single-use: consumed even on failure) ──
      const pending = pendingConfirms.get(request.id);
      pendingConfirms.delete(request.id);
      if (!pending || !timingSafeStringEqual(pending.token, request.confirmToken)) {
        return {
          ok: false,
          status: 403,
          message: 'Missing or invalid confirm token; request a fresh confirmation first',
        };
      }
      const atMs = now();
      if (atMs > pending.expiresAtMs) {
        return { ok: false, status: 403, message: 'Confirm token expired; request a fresh confirmation' };
      }
      if (pending.action !== request.action
        || (pending.sourceList ?? null) !== (request.sourceList ?? null)) {
        return {
          ok: false,
          status: 403,
          message: 'Confirm token was issued for a different decision; request a fresh confirmation',
        };
      }
      if (pending.sourceListsFingerprint !== sourceListsFingerprint()) {
        return {
          ok: false,
          status: 409,
          message: 'Intake source lists changed since confirmation; review the item again',
        };
      }

      const entry = deps.store.getById(request.id);
      if (!entry) {
        return { ok: false, status: 404, message: `Quarantine item not found: ${request.id}` };
      }
      if ((pending.contentSha256 ?? null) !== (entry.envelope.contentRef.sha256 ?? null)) {
        return {
          ok: false,
          status: 409,
          message: 'Held content changed since confirmation; review the item again',
        };
      }
      const validated = validateRequestShape(request, entry);
      if (!validated.ok) return validated;

      // ── Flywheel first: extra policy with the item still held is the safe
      // failure direction (never a released item with a failed policy write).
      let flywheelMessage = '';
      if (request.sourceList && validated.target) {
        const list = flywheelListFor(validated.target, request.sourceList);
        const existing = deps.settingsService.getIntakeSourceLists()[list]
          .some((listEntry) => listEntry.pattern === validated.target?.pattern);
        if (existing) {
          flywheelMessage = `; sourceLists.${list} already contains '${validated.target.pattern}'`;
        } else {
          const mutation = deps.settingsService.mutateIntakeSourceList({
            action: 'add',
            list,
            pattern: validated.target.pattern,
            note: `garden-flywheel: quarantine ${request.action} for envelope ${entry.id}`,
          });
          if (!mutation.ok) {
            return {
              ok: false,
              status: 409,
              message: `Source-list update failed (decision NOT applied): ${mutation.message}`,
            };
          }
          flywheelMessage = `; added '${validated.target.pattern}' to sourceLists.${list}`;
        }
      }

      // ── CogSec ledger: applying → applied/failed around the store mutation,
      // so a crash mid-decision is visible in the case history (fail closed).
      const severity: CogSecSeverity = request.action === 'release_raw' ? 'medium' : 'low';
      const decisionPhrase = request.action === 'release_raw'
        ? 'released one quarantined item verbatim after review'
        : request.action === 'release_sanitized'
          ? 'released the neutral safe representation of one quarantined item after review'
          : 'discarded one quarantined item after review (held content scrubbed)';
      const cogSecEvents = deps.cogSecEvents();
      const event = cogSecEvents.createEvent({
        type: 'intake_firewall',
        severity,
        status: 'applying',
        sourceChannelId: entry.sourceChannelId ?? 'garden:intake-quarantine',
        actor: OPERATOR_ACTOR,
        actions: [],
        safeAgentSummary: `Operator ${decisionPhrase} `
          + `(${entry.envelope.sourceClass}, envelope ${entry.id})`,
        ...(entry.envelope.contentRef.sha256
          ? { sealedForensicPayloadHashes: [`sha256:${entry.envelope.contentRef.sha256}`] }
          : {}),
      });

      let decided: IntakeQuarantineEntry;
      try {
        decided = deps.store.applyDecision({
          id: entry.id,
          action: request.action,
          actor: OPERATOR_ACTOR,
          reason,
          atMs,
        });
      } catch (error) {
        cogSecEvents.updateEvent(event.caseId, {
          status: 'failed',
          failureDetails: 'Quarantine decision could not be applied; the item state is unchanged '
            + '(see Garden audit timeline and server logs)',
        });
        return {
          ok: false,
          status: 500,
          message: `Quarantine decision failed (case ${event.caseId}): ${toErrorMessage(error)}`,
        };
      }
      cogSecEvents.updateEvent(event.caseId, {
        status: 'applied',
        appliedAt: new Date(atMs).toISOString(),
      });

      return {
        ok: true,
        item: toItemView(decided, atMs),
        message: `Applied ${request.action} to quarantine item ${entry.id}${flywheelMessage}`,
        cogSecCaseId: event.caseId,
      };
    },
  };
}
