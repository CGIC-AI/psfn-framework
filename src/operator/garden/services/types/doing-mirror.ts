import type {
  DoingMirrorItem,
  DoingMirrorItemType,
  DoingMirrorTransitionInput,
} from '../../../../core/doing-mirror/contracts.js';

export interface AdminDoingMirrorService {
  list(): Promise<DoingMirrorItem[]>;
  get(itemType: DoingMirrorItemType, itemId: string): Promise<DoingMirrorItem>;
  transition(input: DoingMirrorTransitionInput): Promise<DoingMirrorItem>;
  /**
   * psfn-framework-nwtw1: operator retry for a disposition whose Letter delivery
   * was quarantined after repeated failures. Clears the failure counter and
   * attempts delivery once so Garden reports the real outcome.
   */
  retryLetterDelivery(itemType: DoingMirrorItemType, itemId: string): Promise<DoingMirrorItem>;
}
