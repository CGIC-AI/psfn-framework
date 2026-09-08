// ── Content-addressed CogSec admission for wiki documents (1fjvm.2) ──
//
// A wiki document is a prompt-bearing artifact: its body reaches model context
// through semantic retrieval and through the wiki tool. Its `bodySha256` is an
// INTEGRITY check — it proves the body matches the metadata that was written
// beside it — and is never a security verdict: a restore or an out-of-band
// rewrite that updates both stays perfectly consistent and completely
// unscreened.
//
// So admission is content-addressed over the CANONICAL PROMPT REPRESENTATION:
// the body plus every security-relevant metadata field that travels with it
// into a prompt. A body-only tamper, a body+metadata tamper with a matching
// checksum, and a metadata-only change to the fields that shape how the text is
// trusted all produce a different hash, therefore no receipt, therefore a
// rescreen.
//
// Version, timestamps, and `updatedBy` are deliberately EXCLUDED: an exact
// restore of an already-admitted document must hash identically to the document
// that was admitted, or a restore would re-screen the entire wiki for no
// security reason. They are audit fields; they do not change what the text says
// or how far it is trusted.
//
// The gate keeps a small in-process registry so the SYNCHRONOUS read paths
// (`WikiStore.list`, `WikiStore.search`) can ask a question the asynchronous
// receipt store cannot answer in time. The registry is keyed by the document's
// canonical hash, not its id, so a document that changed since it was admitted
// reads back as `unknown` — never as its previous verdict.

import { canonicalJsonString } from '../../shared/utils/json-serialization.js';
import { cogSecContentSha256 } from '../../shared/contracts/cogsec-receipt.js';
import type { CogSecArtifactAdmissionPort } from '../../core/cogsec/intake/durable-admission.js';
import type { WikiDocument } from './types.js';

/**
 * The exact bounded bytes admission hashes and screens for one document.
 *
 * Every field here either IS prompt text or governs how that text is trusted
 * downstream (source class, sensitivity, scope, lineage). Adding a field is a
 * screening-surface change; removing one opens a channel that reaches the
 * prompt without admission.
 */
export function wikiAdmissionContent(document: WikiDocument): string {
  return canonicalJsonString({
    id: document.id,
    title: document.title,
    summary: document.summary ?? null,
    tags: [...document.tags].sort(),
    sourceClass: document.sourceClass,
    scope: document.scope ?? null,
    sensitivity: document.sensitivity,
    provenanceRefs: [...document.provenanceRefs].sort(),
    bodyFormat: document.bodyFormat,
    body: document.body,
  }, 'wiki admission content');
}

/**
 * - `admitted`: these exact canonical bytes passed admission;
 * - `held`: these exact canonical bytes were screened and withheld;
 * - `unknown`: no admission decision exists for these bytes — the document was
 *   never admitted in this process, or it changed since it was. Read paths
 *   treat `unknown` exactly like `held`; the distinction exists so operator
 *   telemetry can tell "refused" from "not yet decided".
 */
type WikiDocumentAdmissionState = 'admitted' | 'held' | 'unknown';

export interface WikiDocumentAdmission {
  state: WikiDocumentAdmissionState;
  /** Operator-facing, content-free reason. Empty while `admitted`. */
  detail: string;
  /**
   * sha256 of the document's canonical prompt representation AS IT IS RIGHT
   * NOW (psfn-framework-ccgdz.4). Always present, and always the hash the state
   * describes: `admitted` means these exact bytes hold a receipt. Callers that
   * record an admission hash must therefore only record it alongside an
   * `admitted` state, or they would name bytes that were never cleared.
   */
  contentSha256: string;
}

export interface WikiAdmissionGate {
  /**
   * Screen or receipt-verify one document's canonical bytes and record the
   * verdict. Idempotent for unchanged bytes: the second call is a
   * content-addressed receipt lookup with no scan.
   */
  admit(document: WikiDocument): Promise<WikiDocumentAdmission>;
  /**
   * The recorded verdict for these EXACT canonical bytes, without I/O. Any
   * document whose bytes differ from the recorded ones is `unknown`.
   */
  status(document: WikiDocument): WikiDocumentAdmission;
}

interface AdmissionRecord {
  contentSha256: string;
  state: Exclude<WikiDocumentAdmissionState, 'unknown'>;
  detail: string;
}

const UNKNOWN_DETAIL = 'no CogSec admission decision exists for this document version';

export function createWikiAdmissionGate(
  admission: CogSecArtifactAdmissionPort,
): WikiAdmissionGate {
  const records = new Map<string, AdmissionRecord>();
  // Per-document sequence number. A slower admit for an older version must
  // never overwrite the verdict of a newer one (the projection race): the
  // result is discarded unless its ticket is still the latest issued.
  const tickets = new Map<string, number>();

  function statusFor(document: WikiDocument, contentSha256: string): WikiDocumentAdmission {
    const record = records.get(document.id);
    if (!record || record.contentSha256 !== contentSha256) {
      return { state: 'unknown', detail: UNKNOWN_DETAIL, contentSha256 };
    }
    return { state: record.state, detail: record.detail, contentSha256 };
  }

  return {
    async admit(document) {
      const content = wikiAdmissionContent(document);
      const contentSha256 = cogSecContentSha256(content);
      const ticket = (tickets.get(document.id) ?? 0) + 1;
      tickets.set(document.id, ticket);
      const outcome = await admission.admit({
        content,
        artifactRef: document.id,
        origin: { ref: `wiki:${document.id}`, detail: document.sourceClass },
      });
      // A 'sanitize' decision admits TRANSFORMED bytes, not the ones on disk.
      // The wiki serves the stored document, and there is no seam here that can
      // substitute the transform without rewriting the canonical file — so the
      // document is held with an actionable reason rather than served in the
      // form screening declined to admit.
      const record: AdmissionRecord = ((): AdmissionRecord => {
        if (!outcome.admitted) {
          return { contentSha256, state: 'held', detail: outcome.detail };
        }
        if (outcome.via === 'screening' && outcome.content !== content) {
          return {
            contentSha256,
            state: 'held',
            detail: 'CogSec intake screening admits this wiki document only in sanitized form; '
              + 'rewrite it through the wiki tool so the sanitized text becomes canonical',
          };
        }
        return { contentSha256, state: 'admitted', detail: '' };
      })();
      if (tickets.get(document.id) === ticket) records.set(document.id, record);
      return { state: record.state, detail: record.detail, contentSha256 };
    },
    status(document) {
      return statusFor(document, cogSecContentSha256(wikiAdmissionContent(document)));
    },
  };
}
