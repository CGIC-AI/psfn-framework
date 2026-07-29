import type {
  RuntimeFallbackProvenance,
  RuntimeFallbackStrategy,
} from './contracts/runtime.js';
import { isRecord } from './utils/types.js';

const RUNTIME_FALLBACK_STRATEGIES = new Set<RuntimeFallbackStrategy>([
  'runtime_nonfabricating_notice',
  // Legacy strategy — no longer written, but kept accepted so historical turn
  // records persisted before the datetime-guard fix still normalize on read.
  'runtime_datetime_contradiction_refusal',
]);

export function normalizeRuntimeFallbackProvenance(
  value: unknown,
  fieldName = 'runtimeFallbackProvenance',
): RuntimeFallbackProvenance {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${fieldName}.schemaVersion must be 1`);
  }
  if (value.authoredBy !== 'runtime') {
    throw new Error(`${fieldName}.authoredBy must be "runtime"`);
  }
  if (value.model !== 'runtime-fallback') {
    throw new Error(`${fieldName}.model must be "runtime-fallback"`);
  }
  if (
    typeof value.strategy !== 'string'
    || !RUNTIME_FALLBACK_STRATEGIES.has(value.strategy as RuntimeFallbackStrategy)
  ) {
    throw new Error(`${fieldName}.strategy is invalid`);
  }

  return {
    schemaVersion: 1,
    authoredBy: 'runtime',
    model: 'runtime-fallback',
    strategy: value.strategy as RuntimeFallbackStrategy,
  };
}

/**
 * A fixed, operator-reviewable phrase that appears verbatim in EVERY
 * runtime-authored fallback reply template below. It doubles as the detection
 * anchor the CogSec memory-candidacy gate keys on, mirroring
 * `INTAKE_FIREWALL_NOTICE_SIGNATURE` (src/core/cogsec/intake-firewall-notice-
 * templates.ts): plain prose the operator can read, not a hidden machine
 * marker embedded in companion-facing text.
 */
export const RUNTIME_FALLBACK_NOTICE_SIGNATURE = 'my image reader failed before I could inspect';

/**
 * The complete, fixed set of runtime-authored fallback reply templates
 * (psfn-framework-zagpk, charter Law 17 / section 8.5). These are the ONLY
 * texts the runtime is sanctioned to deliver in the companion's channel voice:
 * each is propositionally TRUE about a runtime failure ("my image reader
 * failed"), never a fabricated stance or belief. No LLM ever generates this
 * text, and no untrusted content is interpolated into it.
 *
 * The persisted session entry for a delivered template always carries
 * `metadata.runtimeFallbackProvenance`; the entry-level marker is the primary
 * self-report exclusion, and the signature phrase here is the text-level
 * backstop for candidacy callers that only see synthesized text.
 */
export const RUNTIME_FALLBACK_NOTICE_TEMPLATES = Object.freeze({
  visionUnavailableWithText:
    'I got your message, but my image reader failed before I could inspect the '
    + 'attachment. I can respond to the text, but I should not pretend I saw the '
    + 'image. Please resend it if the visual details matter.',
  visionUnavailableImageOnly:
    'I got the image attachment, but my image reader failed before I could '
    + 'inspect it. Please resend it or describe what you want me to check.',
} as const);

// Fail-closed self-check at import time: every template must carry the
// signature phrase, otherwise the memory-candidacy backstop silently stops
// covering it. A wording edit that drops the signature refuses to start.
for (const [name, text] of Object.entries(RUNTIME_FALLBACK_NOTICE_TEMPLATES)) {
  if (!text.includes(RUNTIME_FALLBACK_NOTICE_SIGNATURE)) {
    throw new Error(
      `runtime fallback notice template "${name}" is missing the required signature phrase`,
    );
  }
}

/**
 * True when the supplied text is a runtime-authored fallback notice.
 *
 * Used by the CogSec memory-candidacy gate so runtime-authored fallback
 * wording never becomes durable companion self-report memory, even when it
 * reaches candidacy through a path that only carries text (sleeptime writes,
 * core-memory tools) rather than the provenance-marked session entry.
 */
export function isRuntimeFallbackNoticeText(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  return text.includes(RUNTIME_FALLBACK_NOTICE_SIGNATURE);
}
