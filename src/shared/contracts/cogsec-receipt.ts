// ── Core content-addressed CogSec screening receipt (psfn-framework-1fjvm.3) ──
//
// A receipt is the durable, content-addressed proof that ONE exact byte
// sequence was ADMITTED by the CogSec intake firewall under ONE exact
// screening contract. It exists so a byte-identical durable artifact (an
// executable skill body, a generated or restored wiki document) does not
// repeatedly pay L2/L3 latency and model cost, while any security-relevant
// change re-screens.
//
// Trust posture:
// - The receipt binds the sha256 of the EXACT admitted bytes. One changed byte
//   is a different content hash and therefore no receipt at all.
// - It binds a screening-contract digest (policy, rules fingerprint, mode,
//   posture, source class/tier, scanner set, semantic-layer outcomes). Contract
//   drift is a different digest and therefore no reuse.
// - It binds issuer identity and an expiry. An unknown issuer or an expired
//   receipt fails closed with a typed reason; there is no permanent clean bit.
// - `receiptSha256` binds every other field, so a receipt handed between
//   subsystems cannot have its verdict, expiry, or issuer edited in flight.
//
// Path, mtime, inode, size, source id, and friendly version labels are NEVER
// trust substitutes here. The L1 rule-file fingerprint participates in the
// contract digest in the INVALIDATING direction only: a changed fingerprint
// can only deny reuse, never grant it.

import { createHash } from 'node:crypto';
import { canonicalJsonString } from '../utils/json-serialization.js';
import { isRecord } from '../utils/types.js';
import {
  isCogSecMode,
  type CogSecMode,
  type CogSecStructuralSurface,
  type CogSecVector,
  type IntakeEnforcementPosture,
} from './cogsec-mode.js';
import {
  isIntakeDerivationKind,
  isIntakeEnvelopeState,
  isIntakeRiskLabel,
  isIntakeSourceClass,
  isIntakeSourceRiskTier,
  type IntakeDerivationKind,
  type IntakeEnvelopeState,
  type IntakeRiskLabel,
  type IntakeSourceClass,
  type IntakeSourceRiskTier,
} from './intake-envelope.js';

const COGSEC_RECEIPT_SCHEMA_VERSION = 1 as const;

/** Shape/algorithm version of the screening-contract digest preimage. */
const COGSEC_SCREENING_CONTRACT_DIGEST_VERSION = 1 as const;

/**
 * The single issuer identity Core mints under: the CogSec intake firewall.
 * Verifiers pass their own trusted-issuer set; nothing defaults it, so an
 * unproved issuer can never be admitted by omission.
 */
export const COGSEC_INTAKE_FIREWALL_ISSUER_ID = 'cogsec:intake-firewall';

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

/** Actions that ADMIT content. Quarantine and block never produce a receipt. */
const COGSEC_RECEIPT_ADMITTED_ACTIONS = ['pass', 'sanitize'] as const;
type CogSecReceiptAdmittedAction = typeof COGSEC_RECEIPT_ADMITTED_ACTIONS[number];

function isCogSecReceiptAdmittedAction(
  value: unknown,
): value is CogSecReceiptAdmittedAction {
  return typeof value === 'string'
    && (COGSEC_RECEIPT_ADMITTED_ACTIONS as readonly string[]).includes(value);
}

/**
 * Issuer provenance. `id` is the authority a verifier trusts; `instance` is
 * the acting principal that ran the screening (e.g. 'agent:intake-screening'),
 * kept for audit and never used as a trust decision by itself.
 */
export interface CogSecReceiptIssuer {
  id: string;
  instance: string;
}

/**
 * One hop of the derivation lineage the receipt covers. The root hop is the
 * raw intake bytes; `l1_sanitize` records the deterministic sanitize transform
 * whose output was admitted; an `IntakeDerivationKind` hop records bounded
 * output re-entering CogSec from an isolated derivation, naming the receipt of
 * the content it was derived FROM.
 */
type CogSecReceiptLineageStage = 'raw_intake' | 'l1_sanitize' | IntakeDerivationKind;

export interface CogSecReceiptLineageStep {
  stage: CogSecReceiptLineageStage;
  /** sha256 of the exact bytes this step produced. */
  outputSha256: string;
  /** Transform identity: scanner id, isolation worker id, or 'intake'. */
  transformId: string;
  /** Receipt of the content this step derived from; absent at the root. */
  parentReceiptId?: string;
}

function isCogSecReceiptLineageStage(value: unknown): value is CogSecReceiptLineageStage {
  return value === 'raw_intake' || value === 'l1_sanitize' || isIntakeDerivationKind(value);
}

/** The screening verdict this receipt refers back to. */
interface CogSecReceiptVerdict {
  /** The IntakeEnvelope whose journal holds the full decision evidence. */
  envelopeId: string;
  action: CogSecReceiptAdmittedAction;
  state: IntakeEnvelopeState;
  /** Per-item enforcement posture the decision was taken under. */
  posture: IntakeEnforcementPosture;
  globalMode: CogSecMode;
  sourceClass: IntakeSourceClass;
  sourceRiskTier: IntakeSourceRiskTier;
  decidedAtMs: number;
  riskLabels: readonly IntakeRiskLabel[];
}

/**
 * The effective screening contract a receipt is bound to. Every field either
 * changes what screening WOULD do to the same bytes, or records which layers
 * actually ran. Two runs that disagree on any field produce different digests
 * and therefore never share a receipt.
 *
 * NOT bound (and deliberately so): wall-clock time, origin ref, channel and
 * message identity, contact identity, and the L2/L3 prompt/model/provider
 * identity — the escalation port does not surface the latter to this seam, so
 * `semanticLayers` records only whether each layer ran and how it ended.
 */
export interface CogSecScreeningContractInput {
  /** sha256 of the canonical effective intake policy (all thresholds/tiers/modes). */
  policyDigest: string;
  /**
   * L1 rule-file staleness fingerprint (mtimeNs:size:ino). Invalidating only:
   * a change can deny reuse, and can never grant it.
   */
  ruleFingerprint: string;
  globalMode: CogSecMode;
  posture: IntakeEnforcementPosture;
  cogsecVector: CogSecVector;
  sourceClass: IntakeSourceClass;
  sourceRiskTier: IntakeSourceRiskTier;
  /** Scan scope the L1 pipeline ran under ('context', 'url', ...). */
  scanScope: string;
  /** Scanner ids that produced a result, sorted. */
  scannerIds: readonly string[];
  /** L1.5 scorer id when one ran; absent for L1-only screening. */
  injectionScorerId?: string;
  /** Structurally authenticated surface, when the call site proved one. */
  surface?: CogSecStructuralSurface;
  /** Whether each semantic layer ran, and how it ended. */
  semanticLayers: { l2: string; l3: string };
}

export interface CogSecReceipt {
  schemaVersion: typeof COGSEC_RECEIPT_SCHEMA_VERSION;
  receiptId: string;
  issuer: CogSecReceiptIssuer;
  issuedAtMs: number;
  /** Hard expiry. A verifier at or after this instant fails closed. */
  expiresAtMs: number;
  /** sha256 of the EXACT admitted bytes (post-sanitize when sanitized). */
  contentSha256: string;
  contentSizeBytes: number;
  /** sha256 of the raw pre-screening bytes; equals contentSha256 on 'pass'. */
  rawContentSha256: string;
  screeningContractDigest: string;
  verdict: CogSecReceiptVerdict;
  /** Root-first derivation lineage of the admitted bytes. */
  lineage: readonly CogSecReceiptLineageStep[];
  /** sha256 binding every field above. */
  receiptSha256: string;
}

/** sha256 of exact bytes. Strings are hashed as UTF-8. */
export function cogSecContentSha256(content: string | Uint8Array): string {
  return typeof content === 'string'
    ? createHash('sha256').update(content, 'utf8').digest('hex')
    : createHash('sha256').update(content).digest('hex');
}

function cogSecContentSizeBytes(content: string | Uint8Array): number {
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
}

/**
 * Digest of the effective screening contract. Callers that want to reuse a
 * receipt recompute this from their CURRENT contract and compare; a mismatch
 * is a rescreen, never a downgrade.
 */
export function cogSecScreeningContractDigest(input: CogSecScreeningContractInput): string {
  const preimage = {
    digestVersion: COGSEC_SCREENING_CONTRACT_DIGEST_VERSION,
    policyDigest: requireSha256(input.policyDigest, 'policyDigest'),
    ruleFingerprint: requireText(input.ruleFingerprint, 'ruleFingerprint'),
    globalMode: input.globalMode,
    posture: input.posture,
    cogsecVector: input.cogsecVector,
    sourceClass: input.sourceClass,
    sourceRiskTier: input.sourceRiskTier,
    scanScope: requireText(input.scanScope, 'scanScope'),
    scannerIds: [...input.scannerIds].map((id) => requireText(id, 'scannerIds[]')).sort(),
    injectionScorerId: input.injectionScorerId ?? null,
    surface: input.surface ?? null,
    semanticLayers: {
      l2: requireText(input.semanticLayers.l2, 'semanticLayers.l2'),
      l3: requireText(input.semanticLayers.l3, 'semanticLayers.l3'),
    },
  };
  return createHash('sha256')
    .update(canonicalJsonString(preimage, 'screening contract'), 'utf8')
    .digest('hex');
}

/** Digest of a whole policy object, for `CogSecScreeningContractInput.policyDigest`. */
export function cogSecPolicyDigest(policy: object): string {
  return createHash('sha256')
    .update(canonicalJsonString(policy, 'intake policy'), 'utf8')
    .digest('hex');
}

export interface CreateCogSecReceiptInput {
  receiptId: string;
  issuer: CogSecReceiptIssuer;
  issuedAtMs: number;
  expiresAtMs: number;
  /** The exact bytes admitted downstream. */
  admittedContent: string | Uint8Array;
  /** The raw pre-screening bytes. */
  rawContent: string | Uint8Array;
  screeningContractDigest: string;
  verdict: CogSecReceiptVerdict;
  lineage: readonly CogSecReceiptLineageStep[];
}

/**
 * Mint a receipt for admitted bytes. Pure and side-effect free: persistence is
 * the store's job, and a mint failure is a programming error (invalid input),
 * never a screening outcome.
 */
export function createCogSecReceipt(input: CreateCogSecReceiptInput): CogSecReceipt {
  const unsigned = {
    schemaVersion: COGSEC_RECEIPT_SCHEMA_VERSION,
    receiptId: requireText(input.receiptId, 'receiptId'),
    issuer: normalizeIssuer(input.issuer),
    issuedAtMs: requireTimestamp(input.issuedAtMs, 'issuedAtMs'),
    expiresAtMs: requireTimestamp(input.expiresAtMs, 'expiresAtMs'),
    contentSha256: cogSecContentSha256(input.admittedContent),
    contentSizeBytes: cogSecContentSizeBytes(input.admittedContent),
    rawContentSha256: cogSecContentSha256(input.rawContent),
    screeningContractDigest: requireSha256(
      input.screeningContractDigest,
      'screeningContractDigest',
    ),
    verdict: normalizeVerdict(input.verdict),
    lineage: input.lineage.map(normalizeLineageStep),
  } satisfies Omit<CogSecReceipt, 'receiptSha256'>;
  if (unsigned.expiresAtMs <= unsigned.issuedAtMs) {
    throw new Error('CogSec receipt expiresAtMs must be after issuedAtMs');
  }
  if (unsigned.lineage.length === 0) {
    throw new Error('CogSec receipt lineage must record at least the raw intake step');
  }
  return { ...unsigned, receiptSha256: cogSecReceiptSha256(unsigned) };
}

/**
 * The self-binding digest over every receipt field except the digest itself.
 * Verification recomputes it, so an edited verdict, expiry, or issuer is
 * detected without any trust in the transport that carried the receipt.
 */
function cogSecReceiptSha256(receipt: Omit<CogSecReceipt, 'receiptSha256'>): string {
  return createHash('sha256')
    .update(canonicalJsonString(receipt, 'cogsec receipt'), 'utf8')
    .digest('hex');
}

/**
 * Fail-closed parse of an untrusted receipt (a database row, another
 * process's payload). Every field is re-validated and the self-binding digest
 * is recomputed; anything malformed throws rather than degrading.
 */
export function validateCogSecReceipt(value: unknown): CogSecReceipt {
  if (!isRecord(value)) throw new Error('CogSec receipt must be an object');
  if (value.schemaVersion !== COGSEC_RECEIPT_SCHEMA_VERSION) {
    throw new Error(
      `CogSec receipt schemaVersion must be ${String(COGSEC_RECEIPT_SCHEMA_VERSION)}`,
    );
  }
  if (!Array.isArray(value.lineage)) throw new Error('CogSec receipt lineage must be an array');
  const unsigned = {
    schemaVersion: COGSEC_RECEIPT_SCHEMA_VERSION,
    receiptId: requireText(value.receiptId, 'receiptId'),
    issuer: normalizeIssuer(value.issuer),
    issuedAtMs: requireTimestamp(value.issuedAtMs, 'issuedAtMs'),
    expiresAtMs: requireTimestamp(value.expiresAtMs, 'expiresAtMs'),
    contentSha256: requireSha256(value.contentSha256, 'contentSha256'),
    contentSizeBytes: requireSize(value.contentSizeBytes, 'contentSizeBytes'),
    rawContentSha256: requireSha256(value.rawContentSha256, 'rawContentSha256'),
    screeningContractDigest: requireSha256(
      value.screeningContractDigest,
      'screeningContractDigest',
    ),
    verdict: normalizeVerdict(value.verdict),
    lineage: value.lineage.map(normalizeLineageStep),
  } satisfies Omit<CogSecReceipt, 'receiptSha256'>;
  if (unsigned.expiresAtMs <= unsigned.issuedAtMs) {
    throw new Error('CogSec receipt expiresAtMs must be after issuedAtMs');
  }
  if (unsigned.lineage.length === 0) {
    throw new Error('CogSec receipt lineage must record at least the raw intake step');
  }
  const receiptSha256 = requireSha256(value.receiptSha256, 'receiptSha256');
  if (cogSecReceiptSha256(unsigned) !== receiptSha256) {
    throw new Error('CogSec receipt digest does not bind its fields');
  }
  return { ...unsigned, receiptSha256 };
}

function normalizeIssuer(value: unknown): CogSecReceiptIssuer {
  if (!isRecord(value)) throw new Error('CogSec receipt issuer must be an object');
  return {
    id: requireText(value.id, 'issuer.id'),
    instance: requireText(value.instance, 'issuer.instance'),
  };
}

function normalizeVerdict(value: unknown): CogSecReceiptVerdict {
  if (!isRecord(value)) throw new Error('CogSec receipt verdict must be an object');
  if (!isCogSecReceiptAdmittedAction(value.action)) {
    throw new Error('CogSec receipt verdict action must admit content (pass or sanitize)');
  }
  if (!isIntakeEnvelopeState(value.state)) {
    throw new Error('CogSec receipt verdict state is not an intake envelope state');
  }
  if (value.posture !== 'shadow' && value.posture !== 'enforce') {
    throw new Error('CogSec receipt verdict posture must be shadow or enforce');
  }
  if (!isCogSecMode(value.globalMode)) {
    throw new Error('CogSec receipt verdict globalMode is not a CogSec mode');
  }
  if (!isIntakeSourceClass(value.sourceClass)) {
    throw new Error('CogSec receipt verdict sourceClass is unknown');
  }
  if (!isIntakeSourceRiskTier(value.sourceRiskTier)) {
    throw new Error('CogSec receipt verdict sourceRiskTier is unknown');
  }
  if (!Array.isArray(value.riskLabels)) {
    throw new Error('CogSec receipt verdict riskLabels must be an array');
  }
  const riskLabels = value.riskLabels.map((label) => {
    if (!isIntakeRiskLabel(label)) {
      throw new Error('CogSec receipt verdict riskLabels contains an unknown label');
    }
    return label;
  });
  return {
    envelopeId: requireText(value.envelopeId, 'verdict.envelopeId'),
    action: value.action,
    state: value.state,
    posture: value.posture,
    globalMode: value.globalMode,
    sourceClass: value.sourceClass,
    sourceRiskTier: value.sourceRiskTier,
    decidedAtMs: requireTimestamp(value.decidedAtMs, 'verdict.decidedAtMs'),
    riskLabels,
  };
}

function normalizeLineageStep(value: unknown): CogSecReceiptLineageStep {
  if (!isRecord(value)) throw new Error('CogSec receipt lineage step must be an object');
  if (!isCogSecReceiptLineageStage(value.stage)) {
    throw new Error('CogSec receipt lineage stage is unknown');
  }
  const parentReceiptId = value.parentReceiptId === undefined
    ? undefined
    : requireText(value.parentReceiptId, 'lineage.parentReceiptId');
  return {
    stage: value.stage,
    outputSha256: requireSha256(value.outputSha256, 'lineage.outputSha256'),
    transformId: requireText(value.transformId, 'lineage.transformId'),
    ...(parentReceiptId !== undefined ? { parentReceiptId } : {}),
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`CogSec receipt ${field} must be a non-empty string`);
  }
  return value;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) {
    throw new Error(`CogSec receipt ${field} must be 64 lowercase hex characters`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`CogSec receipt ${field} must be a positive integer timestamp`);
  }
  return value;
}

function requireSize(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`CogSec receipt ${field} must be a non-negative integer`);
  }
  return value;
}
