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

export interface DoingMirrorSourcePort {
  readonly itemType: DoingMirrorItemType;
  list(): Promise<DoingMirrorSourceItem[]>;
  get(itemId: string): Promise<DoingMirrorSourceItem | null>;
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

export interface DoingMirrorStorePort {
  get(itemType: DoingMirrorItemType, itemId: string): Promise<DoingMirrorDispositionRecord | null>;
  list(): Promise<DoingMirrorDispositionRecord[]>;
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
