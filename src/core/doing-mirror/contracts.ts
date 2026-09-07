export const DOING_MIRROR_ITEM_TYPES = ['wishlist', 'fold_package'] as const;
export type DoingMirrorItemType = typeof DOING_MIRROR_ITEM_TYPES[number];

export const DOING_MIRROR_STATES = ['open', 'considering', 'done', 'declined'] as const;
export type DoingMirrorState = typeof DOING_MIRROR_STATES[number];

export interface DoingMirrorSourceItem {
  itemType: DoingMirrorItemType;
  itemId: string;
  ref: string;
  title: string;
  summary?: string;
  createdAt: number;
  origin: {
    kind: 'companion';
    provenanceRefs: string[];
  };
}

interface DoingMirrorLetterNotification {
  letterId: string;
  subject: string;
  body: string;
  deliveredAt?: number;
  /**
   * Consecutive delivery failures since the last successful delivery or
   * operator retry. Zero whenever the Letter is delivered or the operator has
   * cleared the row.
   */
  failureCount: number;
  /** Sanitized message from the most recent failed delivery attempt. */
  lastError?: string;
  lastFailedAt?: number;
  /**
   * Stamped once consecutive failures reach the owner-file threshold. The drain
   * skips quarantined rows so a permanently failing Letter cannot starve newer
   * pending deliveries; only an explicit operator retry clears it.
   */
  quarantinedAt?: number;
}

export interface DoingMirrorDispositionRecord {
  itemType: DoingMirrorItemType;
  itemId: string;
  state: Exclude<DoingMirrorState, 'open'>;
  reason?: string;
  version: number;
  updatedAt: number;
  updatedBy: 'partner';
  notification: DoingMirrorLetterNotification;
}

interface DoingMirrorOpenDisposition {
  itemType: DoingMirrorItemType;
  itemId: string;
  state: 'open';
  version: 0;
  updatedAt: number;
  updatedBy: 'companion';
}

export type DoingMirrorDisposition = DoingMirrorOpenDisposition | DoingMirrorDispositionRecord;

export interface DoingMirrorItem {
  source: DoingMirrorSourceItem;
  disposition: DoingMirrorDisposition;
}

export interface DoingMirrorSourceDispositionInput {
  itemId: string;
  state: Exclude<DoingMirrorState, 'open'>;
  /** Present for every decline; the lifecycle refuses one without a reason. */
  reason?: string;
}

export interface DoingMirrorSourcePort {
  readonly itemType: DoingMirrorItemType;
  list(): Promise<DoingMirrorSourceItem[]>;
  get(itemId: string): Promise<DoingMirrorSourceItem | null>;
  /**
   * psfn-framework-p4rmp: project the recorded Partner disposition onto the
   * source item's own operator-facing lifecycle, so a wish cannot be terminal
   * in the doing mirror while still open in the wiki (or the reverse). This
   * writes only operator-owned lifecycle fields; companion-authored content is
   * never touched and decision authority does not move.
   *
   * Runs on every delivery attempt, including the maintenance drain and an
   * operator retry, so it MUST be idempotent. A source with no separate
   * lifecycle to converge omits it.
   */
  applyDisposition?(input: DoingMirrorSourceDispositionInput): Promise<void>;
}

export interface DoingMirrorTransitionStoreInput {
  itemType: DoingMirrorItemType;
  itemId: string;
  expectedState: DoingMirrorState;
  expectedVersion: number;
  state: Exclude<DoingMirrorState, 'open'>;
  reason?: string;
  updatedAt: number;
  letterId: string;
  letterSubject: string;
  letterBody: string;
}

export interface DoingMirrorLetterFailureInput {
  itemType: DoingMirrorItemType;
  itemId: string;
  letterId: string;
  /** Sanitized failure message shown to the operator in Garden. */
  error: string;
  failedAt: number;
  /** Owner-file bound: reaching this many consecutive failures quarantines the row. */
  maxDeliveryFailures: number;
}

export interface DoingMirrorStorePort {
  get(itemType: DoingMirrorItemType, itemId: string): Promise<DoingMirrorDispositionRecord | null>;
  list(): Promise<DoingMirrorDispositionRecord[]>;
  /**
   * Oldest-first dispositions whose Partner-authored Letter never reached the
   * bin, so a crash between `transition` and `markLetterDelivered` is drained
   * automatically instead of waiting for the operator to resubmit the form.
   * Quarantined rows are excluded: they stay visible through `list` but never
   * consume a slot in the bounded drain batch.
   */
  listPendingLetterDeliveries(limit: number): Promise<DoingMirrorDispositionRecord[]>;
  /**
   * Record one failed delivery attempt against the current Letter, quarantining
   * the row once the consecutive-failure count reaches `maxDeliveryFailures`.
   * The write is scoped to `letterId` so a failure racing a newer transition
   * cannot poison the new Letter.
   */
  recordLetterDeliveryFailure(
    input: DoingMirrorLetterFailureInput,
  ): Promise<DoingMirrorDispositionRecord>;
  /**
   * Clear the consecutive-failure count, last error, and quarantine stamp so an
   * operator retry re-enters the ordinary drain.
   */
  resetLetterDeliveryFailures(
    itemType: DoingMirrorItemType,
    itemId: string,
  ): Promise<DoingMirrorDispositionRecord>;
  transition(input: DoingMirrorTransitionStoreInput): Promise<DoingMirrorDispositionRecord>;
  markLetterDelivered(
    itemType: DoingMirrorItemType,
    itemId: string,
    letterId: string,
    deliveredAt: number,
  ): Promise<DoingMirrorDispositionRecord>;
  close(): Promise<void>;
}

export interface DoingMirrorTransitionInput {
  itemType: DoingMirrorItemType;
  itemId: string;
  state: Exclude<DoingMirrorState, 'open'>;
  reason?: string;
  /** Exact Partner-authored Letter subject; machinery never invents this text. */
  subject: string;
  /** Exact Partner-authored Letter body; machinery never invents this text. */
  body: string;
}
