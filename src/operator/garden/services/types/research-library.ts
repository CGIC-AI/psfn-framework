import type {
  ResearchLibraryEntryDetail,
  ResearchLibraryEntrySummary,
} from '../../../../faculties/memory/research-library/types.js';

export interface AdminResearchLibraryData {
  entries: ResearchLibraryEntrySummary[];
}

export interface AdminResearchLibraryService {
  listEntries(): AdminResearchLibraryData;
  getEntry(id: string): ResearchLibraryEntryDetail | null;
}
