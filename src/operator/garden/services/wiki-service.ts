import { WikiStore } from '../../../faculties/wiki/store.js';
import type {
  AdminWikiListData,
  AdminWikiService,
} from './types.js';

const WIKI_BOUNDARY =
  'Wiki/reference knowledge is workspace-backed durable reference material, separate from L0/L0.1/L2 memory.';

export class AdminWikiDataService implements AdminWikiService {
  private readonly store: WikiStore;

  constructor(workspacePath: string) {
    this.store = new WikiStore(workspacePath);
  }

  async listWikiDocuments(): Promise<AdminWikiListData> {
    return {
      roots: this.store.getRootInfo(),
      documents: this.store.list(),
      boundary: WIKI_BOUNDARY,
    };
  }

  async getWikiDocument(id: string) {
    return this.store.get(id);
  }

  async searchWikiDocuments(query: { query: string; limit?: number }) {
    return this.store.search(query);
  }
}
