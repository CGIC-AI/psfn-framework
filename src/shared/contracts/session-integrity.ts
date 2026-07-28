// ── Session-integrity failure seam (bead psfn-framework-g59z) ──
//
// A narrow, content-FREE contract that carries a session HMAC-chain
// verification failure from the persistence-layer journal readers (where the
// failure is detected) to a durable-incident subscriber (which records it for
// Garden operator visibility). Deliberately placed in shared/contracts so the
// persistence emitter and the core/cogsec subscriber both depend only on this
// contract — no cross-layer import between persistence and core, and no
// gateway/agent or operator/garden boundary crossing in the type graph.
//
// STRICT no-content rule: this event NEVER carries message text, summaries,
// author identities, or any journal payload — only structural counts, entry-id
// ranges, and timestamps. The durable incident it feeds is operator-only and
// must remain safe to surface without leaking companion history.

export interface SessionIntegrityFailureEvent {
  /**
   * Logical session / channel id of the affected L0 archive chain. This is the
   * archive channelId used everywhere else in the session store; it is an
   * identifier, not content.
   */
  channelId: string;
  /** Total journal entries in the load whose HMAC verification failed (>= 1). */
  failedEntryCount: number;
  /** Lowest failed journal entry id in the load (>= 1). */
  firstFailedEntryId: number;
  /** Highest failed journal entry id in the load (>= firstFailedEntryId). */
  lastFailedEntryId: number;
  /**
   * Number of distinct contiguous HMAC-failed runs observed in the load. One
   * corrupted stretch is a single run; interleaved good/bad entries raise it.
   * Mirrors the render-side run-collapse semantics.
   */
  contiguousRunCount: number;
  /** Wall-clock ms at detection. */
  detectedAtMs: number;
}

/**
 * The single subscriber seam. The persistence layer holds one of these
 * (optional) and calls it best-effort when a full journal load surfaces one or
 * more HMAC-failed entries. Implementations MUST NOT throw back into the read
 * path (integrity reads are fail-closed already; recording is a side signal),
 * and MUST treat the event as content-free.
 */
export interface SessionIntegrityObserver {
  recordIntegrityFailure(event: SessionIntegrityFailureEvent): void;
}
