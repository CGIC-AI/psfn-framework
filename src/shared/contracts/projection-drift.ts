// ── Redaction projection-drift seam (bead psfn-framework-6oott) ──
//
// A narrow, content-FREE contract that carries a failed redaction-driven
// transcript-projection write from the persistence adapter (where the failure
// is detected in the async write chain) to a durable-incident subscriber
// (which records it for Garden operator visibility). Mirrors the
// session-integrity seam (bead g59z, `session-integrity.ts` in this
// directory): both ends depend only on this contract, so there is no
// cross-layer import between persistence and core/cogsec.
//
// STRICT no-content rule: this event NEVER carries message text or redacted
// payloads — only the channel identifier, a database error string, and a
// timestamp. The durable incident it feeds is operator-only.

export interface RedactionProjectionDriftEvent {
  /** Logical session / channel id whose redaction failed to project. */
  channelId: string;
  /**
   * Database failure description (driver error message). Never message
   * content: the projection write failed before any content-derived text
   * could be involved in the error path.
   */
  reason: string;
  /** Wall-clock ms at drift capture. */
  markedAtMs: number;
}

/**
 * The single subscriber seam. The projection adapter holds one of these
 * (optional) and calls it when a redaction-driven projection mutation fails
 * after its bounded retry, and again on startup for redaction drift preloaded
 * from the durable record (so an incident survives a crash between capture
 * and recording). Implementations MUST NOT throw back into the write chain
 * (search is already fail-closed for the channel; recording is a side
 * signal), and MUST treat the event as content-free.
 */
export interface RedactionProjectionDriftObserver {
  recordRedactionProjectionDrift(event: RedactionProjectionDriftEvent): void;
}
