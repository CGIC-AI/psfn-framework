// ── Durable-artifact CogSec admission (psfn-framework-1fjvm.1 / .2) ──
//
// The single gate a DURABLE, PROMPT-BEARING artifact passes before its bytes
// may reach model context or execute: an executable skill body, a generated or
// restored wiki document. Both consumers use this one primitive, so there is
// exactly one admission policy and one place it can be audited.
//
// The gate is content-addressed, not path- or metadata-addressed:
//
//   1. Ask this screening instance for the screening-contract digest it would
//      bind a receipt to RIGHT NOW for this call site.
//   2. Ask the receipt store, through `resolveAdmittedCogSecReceipt`, whether
//      these EXACT bytes already hold an unexpired, known-issuer receipt under
//      that exact contract.
//   3. On any refusal — not_found, malformed, unknown_issuer,
//      content_hash_mismatch, screening_contract_mismatch, expired — screen the
//      bytes again through the real intake screening service. There is no
//      second screening path here and no verdict this module can reach on its
//      own.
//
// Every failure direction denies reuse and costs a rescan; none of them admits
// anything. A stale contract digest, an unpredictable contract (null), a store
// error, a mutated file, a restored backup, a rotated issuer, and an expired
// receipt all land on "screen it again", and screening's own decision — not
// this module — then admits or withholds.
//
// Enforcement is deliberately NOT re-derived here. `withheld` is the canonical
// projection of the global mode and the item posture that the rest of the
// codebase already reads: shadow observes and releases, boundary and strict
// withhold. Re-deciding it here would be a second, drifting policy.
//
// Path, mtime, inode, size, source precedence, and prior admission of a
// DIFFERENT version of the same artifact are never trust substitutes.

import { performance } from 'node:perf_hooks';
import { createComponentLogger } from '../../../shared/logger.js';
import { cogSecContentSha256 } from '../../../shared/contracts/cogsec-receipt.js';
import type { IntakeRiskLabel, IntakeSourceClass } from '../../../shared/contracts/intake-envelope.js';
import type { IntakeScanScope } from './scanners/index.js';
import type { CogSecReceiptStorePort } from '../receipts/contracts.js';
import { resolveAdmittedCogSecReceipt } from '../receipts/verification.js';
import type { IntakeScreeningInput, IntakeScreeningService } from './screening.js';

const log = createComponentLogger('CogSecDurableAdmission');

/**
 * Durable artifacts re-enter the prompt path as stored documents, never as a
 * live tool result or companion self-talk. Screening them under an EXTERNAL
 * source class is load-bearing: the boundary-mode clean bubble releases
 * internal vectors with zero scanner calls, so an internal class here would
 * make the whole gate inert in boundary mode.
 */
const DURABLE_ARTIFACT_SOURCE_CLASS: IntakeSourceClass = 'document';

/** Whole-document screening, matching the protected skill-write path. */
const DURABLE_ARTIFACT_SCAN_SCOPE: IntakeScanScope = 'strict';

/** Which prompt-bearing artifact class an admission decision covers. */
type CogSecAdmittedArtifactKind = 'skill' | 'wiki_document';

/**
 * Why the bytes are inert. Every value is operator-visible and content-free:
 * - `quarantined`: screening ran and withheld the content under the current
 *   enforcement posture;
 * - `admission_unavailable`: the receipt store or the screening service failed,
 *   so no admission decision exists — the artifact stays inert rather than
 *   being released on a broken gate.
 */
type CogSecAdmissionHoldReason = 'quarantined' | 'admission_unavailable';

interface CogSecAdmissionRequest {
  /** The exact bytes that must be admitted before they reach a prompt. */
  content: string;
  /** Content-free artifact identity for telemetry (a name or relative path). */
  artifactRef: string;
  /** Origin locator recorded on the intake envelope. Never the bytes. */
  origin: { ref: string; detail?: string };
}

type CogSecArtifactAdmission =
  | {
    admitted: true;
    /**
     * The bytes the caller may use. Equal to the presented content on the
     * receipt path and on a `pass`; the L1-sanitized text on a `sanitize`.
     */
    content: string;
    /** Present when the admission is backed by a durable receipt. */
    receiptId?: string;
    /** Whether an existing receipt was reused or the bytes were screened now. */
    via: 'receipt' | 'screening';
  }
  | {
    admitted: false;
    reason: CogSecAdmissionHoldReason;
    /** Operator-facing explanation. Content-free by construction. */
    detail: string;
    /** Content-free screening labels behind a `quarantined` hold. */
    riskLabels: readonly IntakeRiskLabel[];
  };

/**
 * Content-free admission telemetry. Carries the content HASH — the artifact's
 * canonical identity in this lane — and never the bytes, a preview, or a
 * finding excerpt.
 */
export interface CogSecArtifactAdmissionEvent {
  artifactKind: CogSecAdmittedArtifactKind;
  artifactRef: string;
  contentSha256: string;
  outcome: 'receipt_reused' | 'screened_admitted' | 'held';
  /**
   * Why a receipt could not be reused, when it could not:
   * a `CogSecReceiptVerification` refusal reason, or `contract_unpredictable`
   * when this screening instance cannot state its own current contract.
   */
  receiptRefusal?: string;
  holdReason?: CogSecAdmissionHoldReason;
  riskLabels?: readonly IntakeRiskLabel[];
  durationMs: number;
}

/**
 * The gate a durable artifact passes before its bytes reach a prompt or
 * execute. Absent from a composition, the consumer has no admission authority
 * and must say so explicitly rather than assume clearance.
 */
export interface CogSecArtifactAdmissionPort {
  admit(request: CogSecAdmissionRequest): Promise<CogSecArtifactAdmission>;
}

export interface CogSecArtifactAdmissionOptions {
  kind: CogSecAdmittedArtifactKind;
  /** The real intake screening service; the only verdict authority here. */
  screening: IntakeScreeningService;
  /** Durable receipt store, read through `resolveAdmittedCogSecReceipt`. */
  receipts: CogSecReceiptStorePort;
  /**
   * Issuing authorities this consumer accepts. Empty admits nothing, so an
   * unconfigured trust set degrades to "screen everything", never to "trust
   * everything".
   */
  trustedIssuerIds: readonly string[];
  now?: () => number;
  /** Content-free observer. A throwing observer is isolated from admission. */
  onAdmission?: (event: CogSecArtifactAdmissionEvent) => void;
}

export function createCogSecArtifactAdmission(
  options: CogSecArtifactAdmissionOptions,
): CogSecArtifactAdmissionPort {
  const { kind, screening, receipts, trustedIssuerIds } = options;
  const now = options.now ?? Date.now;

  function emit(event: CogSecArtifactAdmissionEvent): void {
    if (!options.onAdmission) return;
    try {
      options.onAdmission(event);
    } catch (error) {
      log.warn('CogSec artifact admission observer failed', {
        artifactKind: event.artifactKind,
        artifactRef: event.artifactRef,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function admit(request: CogSecAdmissionRequest): Promise<CogSecArtifactAdmission> {
    const startedAt = performance.now();
    const contentSha256 = cogSecContentSha256(request.content);
    const input: IntakeScreeningInput = {
      sourceClass: DURABLE_ARTIFACT_SOURCE_CLASS,
      scope: DURABLE_ARTIFACT_SCAN_SCOPE,
      origin: request.origin,
    };

    let receiptRefusal = 'contract_unpredictable';
    try {
      const expectedScreeningContractDigest = screening.screeningContractDigest(input);
      if (expectedScreeningContractDigest !== null) {
        const verification = await resolveAdmittedCogSecReceipt(receipts, {
          content: request.content,
          expectedScreeningContractDigest,
          trustedIssuerIds,
          nowMs: now(),
        });
        if (verification.admitted) {
          emit({
            artifactKind: kind,
            artifactRef: request.artifactRef,
            contentSha256,
            outcome: 'receipt_reused',
            durationMs: performance.now() - startedAt,
          });
          return {
            admitted: true,
            content: request.content,
            receiptId: verification.receipt.receiptId,
            via: 'receipt',
          };
        }
        receiptRefusal = verification.reason;
      }
    } catch (error) {
      // A receipt-store failure must never become a silent rescreen-forever,
      // and must never become a silent admission either. It is reported and
      // the artifact is screened; if screening also fails, the artifact holds.
      const detail = error instanceof Error ? error.message : String(error);
      log.error('CogSec admission receipt lookup failed; screening the artifact instead', {
        artifactKind: kind,
        artifactRef: request.artifactRef,
        contentSha256,
        error: detail,
      });
      receiptRefusal = 'lookup_failed';
    }

    let held: { detail: string; riskLabels: readonly IntakeRiskLabel[] } | null = null;
    try {
      const result = await screening.screen(request.content, input);
      if (result.receiptIssuanceError !== undefined) {
        log.warn('CogSec admission screened the artifact but issued no reusable receipt', {
          artifactKind: kind,
          artifactRef: request.artifactRef,
          contentSha256,
          error: result.receiptIssuanceError,
        });
      }
      if (!result.withheld) {
        emit({
          artifactKind: kind,
          artifactRef: request.artifactRef,
          contentSha256,
          outcome: 'screened_admitted',
          receiptRefusal,
          riskLabels: result.envelope.riskLabels,
          durationMs: performance.now() - startedAt,
        });
        return {
          admitted: true,
          content: result.effectiveText,
          ...(result.receipt ? { receiptId: result.receipt.receiptId } : {}),
          via: 'screening',
        };
      }
      held = {
        detail: `CogSec intake screening withheld this ${kind} (${result.action})`,
        riskLabels: result.envelope.riskLabels,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.error('CogSec admission screening failed; the artifact stays inert', {
        artifactKind: kind,
        artifactRef: request.artifactRef,
        contentSha256,
        error: detail,
      });
      emit({
        artifactKind: kind,
        artifactRef: request.artifactRef,
        contentSha256,
        outcome: 'held',
        receiptRefusal,
        holdReason: 'admission_unavailable',
        durationMs: performance.now() - startedAt,
      });
      return {
        admitted: false,
        reason: 'admission_unavailable',
        detail: `CogSec intake screening failed: ${detail}`,
        riskLabels: [],
      };
    }

    emit({
      artifactKind: kind,
      artifactRef: request.artifactRef,
      contentSha256,
      outcome: 'held',
      receiptRefusal,
      holdReason: 'quarantined',
      riskLabels: held.riskLabels,
      durationMs: performance.now() - startedAt,
    });
    return {
      admitted: false,
      reason: 'quarantined',
      detail: held.detail,
      riskLabels: held.riskLabels,
    };
  }

  return { admit };
}
