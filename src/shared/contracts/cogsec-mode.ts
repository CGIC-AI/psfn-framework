// ── Canonical global CogSec enforcement mode ──
//
// ONE global mode governs the whole cognition-security firewall. It is the
// single owner-file value (intake-policy.json `mode`) and the single value
// Garden reads and mutates through the audited owner-file path. Every CogSec
// vector — every declared ingress, internal, and egress surface — is
// classified here and resolved to ONE centralized enforce/monitor decision
// against this mode. There are no per-tool mode forks and no second mode enum:
// screening, sink gates, egress, and the clean bubble all consult this module.
//
// MODES
// - 'shadow':   every declared vector is evaluated and telemetered but NEVER
//               blocks. Observe-only rollout posture.
// - 'boundary': the clean bubble. External ingress (chat/file/web) and
//               registered outbound publication are ENFORCED; structurally
//               authenticated internal activity (own-memory reads, local
//               database reads such as Beads, journal, local fs read/search,
//               approved self-directed shell, and authenticated internal chat)
//               makes ZERO semantic-screening calls and cannot be held solely
//               by its content.
// - 'strict':   every declared vector is enforced — internal activity too.
//
// PROVENANCE IS STRUCTURAL, NOT CONTENT-DERIVED. The clean bubble keys off a
// provenance class that only a structurally authenticated call site can set
// (the tool name and authenticated path), never off message text or model
// arguments. Forging an internal provenance class from content is impossible by
// construction: the classifier never reads the bytes.

import type { IntakeSourceClass } from './intake-envelope.js';

// ── Global mode ──

export const COGSEC_MODES = ['shadow', 'boundary', 'strict'] as const;
export type CogSecMode = typeof COGSEC_MODES[number];

export function isCogSecMode(value: unknown): value is CogSecMode {
  return typeof value === 'string' && (COGSEC_MODES as readonly string[]).includes(value);
}

/**
 * The derived per-instance enforcement posture for an enforcing surface
 * (ingress screening, sink gates, egress). 'shadow' = observe/telemetry only;
 * 'enforce' = the verdict can withhold or block. Both 'boundary' and 'strict'
 * project to 'enforce' because both enforce external ingress and registered
 * outbound publication; the clean-bubble distinction (boundary internal
 * bypass) is resolved per item through {@link resolveCogSecVectorPosture},
 * not through this projection.
 */
export type IntakeEnforcementPosture = 'shadow' | 'enforce';

/**
 * Projects a global mode onto the binary enforcement posture for an enforcing
 * surface. 'shadow' stays observe-only; 'boundary' and 'strict' both enforce.
 */
export function intakeEnforcementPosture(mode: CogSecMode): IntakeEnforcementPosture {
  return mode === 'shadow' ? 'shadow' : 'enforce';
}

// ── Declared CogSec vectors ──

/**
 * Every declared CogSec vector — the closed set of enforcement domains the
 * firewall reasons about. Each is classified external (enforced in boundary)
 * or internal (clean-bubble in boundary). Adding a vector requires a row in
 * the posture matrix and a test; the closed list is the contract that lets
 * Garden, screening, and sink gates share one decision.
 */
export const COGSEC_VECTORS = [
  // External ingress — always screened in boundary and strict.
  'external_chat_ingress',
  'external_file_ingress',
  'external_web_ingress',
  // Registered outbound publication — always gated in boundary and strict.
  'outbound_publication',
  // Internal clean-bubble activity — non-blocking in boundary.
  'internal_chat',
  'own_memory_read',
  'local_database_read',
  'journal',
  'local_fs_read',
  'self_directed_shell',
] as const;

export type CogSecVector = typeof COGSEC_VECTORS[number];

type CogSecVectorClassification = 'external' | 'internal';

/**
 * Structural classification of a vector. External vectors carry untrusted
 * bytes across the companion boundary (chat/file/web ingress, outbound
 * publication). Internal vectors are authenticated companion-owned activity
 * (own memory, local database, journal, local filesystem, self-directed
 * shell, and structurally authenticated internal chat).
 */
function cogSecVectorClassification(vector: CogSecVector): CogSecVectorClassification {
  switch (vector) {
    case 'external_chat_ingress':
    case 'external_file_ingress':
    case 'external_web_ingress':
    case 'outbound_publication':
      return 'external';
    case 'internal_chat':
    case 'own_memory_read':
    case 'local_database_read':
    case 'journal':
    case 'local_fs_read':
    case 'self_directed_shell':
      return 'internal';
  }
}

function isInternalCogSecVector(vector: CogSecVector): boolean {
  return cogSecVectorClassification(vector) === 'internal';
}

// ── Structural provenance class (unforgeable) ──

/**
 * Structural provenance class stamped by an authenticated call site. Only the
 * default 'external' is assumed when no structural proof is supplied; every
 * internal class is set by the call site from STRUCTURAL identity (the tool
 * name plus the authenticated read path), never from message text or model
 * arguments. A model cannot rename its own tool, so it cannot forge an
 * internal provenance class.
 */
export type CogSecProvenanceClass =
  | 'external'
  | 'internal_chat'
  | 'own_memory_read'
  | 'local_database_read'
  | 'journal'
  | 'local_fs_read'
  | 'self_directed_shell';

/** Maps a structural provenance class to its declared CogSec vector. */
export function cogSecVectorForProvenance(
  provenance: CogSecProvenanceClass,
  sourceClass?: IntakeSourceClass,
): CogSecVector {
  switch (provenance) {
    case 'external':
      switch (sourceClass) {
        case 'web_fetch':
        case 'web_search':
          return 'external_web_ingress';
        case 'document':
        case 'image_ocr':
        case 'audio_transcript':
          return 'external_file_ingress';
        default:
          return 'external_chat_ingress';
      }
    case 'internal_chat':
      return 'internal_chat';
    case 'own_memory_read':
      return 'own_memory_read';
    case 'local_database_read':
      return 'local_database_read';
    case 'journal':
      return 'journal';
    case 'local_fs_read':
      return 'local_fs_read';
    case 'self_directed_shell':
      return 'self_directed_shell';
  }
}

/**
 * Resolves the structural provenance class for an ingress screening item from
 * its source class plus an optional structural provenance hint. External
 * source classes that carry untrusted bytes across the boundary always remain
 * 'external' — a structural internal hint is IGNORED for them, so content
 * arriving through external chat/file/web can never claim the clean bubble by
 * attaching a forged hint. Only an explicitly internal source class
 * (companion_self) plus a structural internal hint, or a structural internal
 * hint on a tool_output whose call site proved it, yields an internal class.
 */
export function resolveCogSecProvenanceClass(input: {
  sourceClass: IntakeSourceClass;
  structuralProvenance?: CogSecProvenanceClass;
}): CogSecProvenanceClass {
  const hint = input.structuralProvenance ?? 'external';
  // Internal clean-bubble provenance is honored only when the carrying source
  // class is internal (companion-authored / tool output). External ingress
  // source classes are forced back to 'external' regardless of any hint, so a
  // tool result echoing hostile web content cannot launder itself internal.
  if (hint !== 'external' && isInternalIntakeSourceClass(input.sourceClass)) {
    return hint;
  }
  return 'external';
}

/**
 * Intake source classes eligible to carry an internal clean-bubble provenance.
 * Tool outputs and companion-authored content may be structurally provenanced
 * internal by their authenticated call site; every external ingress class
 * (web/chat/document/transcript/subagent/shard/mcp) is excluded by force.
 */
function isInternalIntakeSourceClass(sourceClass: IntakeSourceClass): boolean {
  return sourceClass === 'tool_output' || sourceClass === 'companion_self';
}

// ── THE centralized enforce/monitor decision ──

export interface CogSecVectorPosture {
  /**
   * Whether semantic screening (L1/L2/L3 scanners) runs for this vector.
   * False only in boundary mode for internal vectors: the clean bubble makes
   * zero semantic-screening calls. Shadow and strict always screen (shadow
   * for telemetry/records, strict for enforcement).
   */
  screens: boolean;
  /**
   * Whether the decision can withhold or block. False in shadow mode (never
   * blocks) and in boundary mode for internal vectors (clean bubble).
   */
  enforces: boolean;
}

/**
 * ONE centralized enforce/monitor decision for a declared vector under a
 * global mode. Every screening, sink-gate, and egress site resolves its
 * posture through this function rather than re-deriving mode semantics.
 *
 * Matrix:
 *   shadow   × any vector        → screens, never blocks (monitor/telemetry)
 *   boundary × external vector   → screens and blocks (enforce)
 *   boundary × internal vector   → no screening, never blocks (clean bubble)
 *   strict   × any vector        → screens and blocks (enforce)
 */
export function resolveCogSecVectorPosture(
  mode: CogSecMode,
  vector: CogSecVector,
): CogSecVectorPosture {
  if (mode === 'shadow') {
    // Shadow evaluates and records every vector but never blocks.
    return { screens: true, enforces: false };
  }
  if (mode === 'boundary' && isInternalCogSecVector(vector)) {
    // Clean bubble: zero semantic-screening calls, cannot hold.
    return { screens: false, enforces: false };
  }
  // boundary × external, and strict × any: full enforcement.
  return { screens: true, enforces: true };
}

/**
 * Convenience: the per-item enforcement posture (for the screening result /
 * sink gate) under which an item was evaluated, derived from the global mode
 * and the item's vector. Internal clean-bubble items project to 'shadow'
 * (observe-only) even under a boundary global mode.
 */
export function cogSecItemEnforcementPosture(
  mode: CogSecMode,
  vector: CogSecVector,
): IntakeEnforcementPosture {
  return resolveCogSecVectorPosture(mode, vector).enforces ? 'enforce' : 'shadow';
}
