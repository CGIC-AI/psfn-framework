import { ResearchLibraryStore } from '../../../research-library/store.js';
import type {
  AdminResearchLibraryData,
  AdminResearchLibraryService,
} from './types.js';

export class AdminResearchLibraryDataService implements AdminResearchLibraryService {
  constructor(private readonly store: ResearchLibraryStore) {}

  listEntries(): AdminResearchLibraryData {
    return {
      entries: this.store.listEntries(),
    };
  }

  getEntry(id: string) {
    return this.store.getEntry(id);
  }
}
