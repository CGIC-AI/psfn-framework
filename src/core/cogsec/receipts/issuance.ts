// ── CogSec receipt issuance (psfn-framework-1fjvm.3) ──
//
// Turns ONE completed screening result into ONE receipt over the exact bytes
// that were admitted. The admission predicate lives here, alone, so every
// exclusion is enumerable and testable:
//
// - quarantine/block decisions, and any withheld item, never get a receipt;
// - a shadow-observed quarantine never gets one either — the decision is what
//   is recorded, not the fact that shadow mode released the bytes anyway;
// - a pending post-pass deep screening gets none until (and unless) the deep
//   layers settle clean, because the verdict does not exist yet;
// - a truncated scan, a scanner error, or an L1.5 scorer error gets none:
//   bytes that were only partly screened must never be provable as screened;
// - the clean-bubble path gets none: zero scanners ran, so there is no
//   screening to certify (the caller decides that; it is not visible here).
//
// Each of those is a fail-closed hole if it is allowed through, because a
// receipt is what lets a later consumer SKIP screening entirely.

import { randomUUID } from 'node:crypto';
import {
  cogSecContentSha256,
  cogSecScreeningContractDigest,
  createCogSecReceipt,
  type CogSecReceipt,
  type CogSecReceiptIssuer,
  type CogSecReceiptLineageStep,
} from '../../../shared/contracts/cogsec-receipt.js';
import type { CogSecStructuralSurface } from '../../../shared/contracts/cogsec-mode.js';
import { isIntakeSinkConsumableState } from '../../../shared/contracts/intake-envelope.js';
import type { IntakeScreeningResult } from '../intake/screening.js';

export const COGSEC_RECEIPT_SUPPRESSIONS = [
  'deep_screening_pending',
  'not_admitted',
  'withheld',
  'envelope_not_consumable',
  'scan_truncated',
  'scanner_error',
  'injection_scorer_error',
] as const;

export type CogSecReceiptSuppression = typeof COGSEC_RECEIPT_SUPPRESSIONS[number];

/**
 * Why this screening result must NOT produce a receipt, or null when it is a
 * complete admission of fully screened bytes.
 */
export function cogSecReceiptSuppression(
  result: IntakeScreeningResult,
): CogSecReceiptSuppression | null {
  if (result.postEscalation === 'pending') return 'deep_screening_pending';
  if (result.action !== 'pass' && result.action !== 'sanitize') return 'not_admitted';
  if (result.withheld) return 'withheld';
  if (!isIntakeSinkConsumableState(result.envelope.state)) return 'envelope_not_consumable';
  if (result.report.truncated) return 'scan_truncated';
  if (result.report.scannerErrors.length > 0) return 'scanner_error';
  if (result.injectionScorerError !== undefined) return 'injection_scorer_error';
  return null;
}

/** Screening-instance facts a receipt is bound to, fixed for the process. */
export interface CogSecReceiptIssuanceContext {
  issuer: CogSecReceiptIssuer;
  /** sha256 of the canonical effective intake policy. */
  policyDigest: string;
  /** L1 rule-file staleness fingerprint at issuance time. */
  ruleFingerprint: string;
  /** Receipt lifetime; there is no permanent clean designation. */
  ttlMs: number;
  /** L1.5 scorer id when the instance has one wired. */
  injectionScorerId?: string;
}

export interface BuildCogSecReceiptInput {
  context: CogSecReceiptIssuanceContext;
  result: IntakeScreeningResult;
  /** The raw bytes handed to screening. */
  rawText: string;
  /** Structurally authenticated surface, when the call site proved one. */
  surface?: CogSecStructuralSurface;
  issuedAtMs: number;
  /** Injectable id source; production uses randomUUID. */
  newReceiptId?: () => string;
}

/**
 * Mint the receipt for an admitted screening result. Returns null when
 * `cogSecReceiptSuppression` refuses the result, so a caller cannot obtain a
 * receipt without passing the predicate.
 */
export function buildCogSecReceipt(input: BuildCogSecReceiptInput): CogSecReceipt | null {
  const { result, context } = input;
  if (cogSecReceiptSuppression(result) !== null) return null;
  const action = result.action === 'sanitize' ? 'sanitize' : 'pass';
  const screeningContractDigest = cogSecScreeningContractDigest({
    policyDigest: context.policyDigest,
    ruleFingerprint: context.ruleFingerprint,
    globalMode: result.globalMode,
    posture: result.mode,
    cogsecVector: result.cogsecVector,
    sourceClass: result.envelope.sourceClass,
    sourceRiskTier: result.envelope.sourceRiskTier,
    scanScope: result.report.scope,
    scannerIds: result.report.results.map((entry) => entry.scannerId),
    ...(context.injectionScorerId !== undefined
      ? { injectionScorerId: context.injectionScorerId }
      : {}),
    ...(input.surface !== undefined ? { surface: input.surface } : {}),
    semanticLayers: {
      l2: result.observability.semanticTrace.l2.status,
      l3: result.observability.semanticTrace.l3.status,
    },
  });
  const lineage: CogSecReceiptLineageStep[] = [{
    stage: 'raw_intake',
    outputSha256: cogSecContentSha256(input.rawText),
    transformId: 'intake',
  }];
  if (action === 'sanitize') {
    lineage.push({
      stage: 'l1_sanitize',
      outputSha256: cogSecContentSha256(result.effectiveText),
      transformId: 'intake-l1-sanitize',
    });
  }
  const decision = result.envelope.decision;
  if (!decision) {
    // An envelope cannot leave 'received' without a decision; reaching here
    // means the screening journal is inconsistent, which is never a silent
    // downgrade to "issue anyway".
    throw new Error('CogSec receipt issuance requires a decided intake envelope');
  }
  return createCogSecReceipt({
    receiptId: (input.newReceiptId ?? randomUUID)(),
    issuer: context.issuer,
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.issuedAtMs + context.ttlMs,
    admittedContent: result.effectiveText,
    rawContent: input.rawText,
    screeningContractDigest,
    verdict: {
      envelopeId: result.envelope.id,
      action,
      state: result.envelope.state,
      posture: result.mode,
      globalMode: result.globalMode,
      sourceClass: result.envelope.sourceClass,
      sourceRiskTier: result.envelope.sourceRiskTier,
      decidedAtMs: decision.decidedAtMs,
      riskLabels: result.envelope.riskLabels,
    },
    lineage,
  });
}
