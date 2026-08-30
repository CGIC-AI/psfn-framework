import type {
  DoingMirrorItem,
  DoingMirrorItemType,
  DoingMirrorTransitionInput,
} from '../../../../core/doing-mirror/contracts.js';

export interface AdminDoingMirrorService {
  list(): Promise<DoingMirrorItem[]>;
  get(itemType: DoingMirrorItemType, itemId: string): Promise<DoingMirrorItem>;
  transition(input: DoingMirrorTransitionInput): Promise<DoingMirrorItem>;
}
