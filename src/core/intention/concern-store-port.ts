type Awaitable<T> = T | Promise<T>;
type ActiveConcern = import('./concerns.js').ActiveConcern;
type ActiveConcernCreateInput = import('./concerns.js').ActiveConcernCreateInput;
type ActiveConcernListOptions = import('./concerns.js').ActiveConcernListOptions;
type ActiveConcernRecentResolutionOptions = import('./concerns.js').ActiveConcernRecentResolutionOptions;
type ActiveConcernResolveOptions = import('./concerns.js').ActiveConcernResolveOptions;
type ActiveConcernStaleResolutionOptions = import('./concerns.js').ActiveConcernStaleResolutionOptions;
type ActiveConcernTransitionOptions = import('./concerns.js').ActiveConcernTransitionOptions;

export interface ActiveConcernContextProvider {
  getActiveConcerns(contactId?: string): ActiveConcern[];
}

export interface ConcernStorePortBackend {
  create(input: ActiveConcernCreateInput): Awaitable<ActiveConcern>;
  getById(id: string): Awaitable<ActiveConcern | null>;
  getActiveConcerns(contactId?: string): Awaitable<ActiveConcern[]>;
  list(options?: ActiveConcernListOptions): Awaitable<ActiveConcern[]>;
  listRecentlyResolvedConcerns(
    contactId?: string,
    options?: ActiveConcernRecentResolutionOptions,
  ): Awaitable<ActiveConcern[]>;
  findRecentlyResolvedSimilarConcern(input: {
    text: string;
    contactId?: string;
    withinMs?: number;
    asOf?: string;
  }): Awaitable<ActiveConcern | null>;
  resolveConcern(
    id: string,
    options?: ActiveConcernResolveOptions,
  ): Awaitable<ActiveConcern | null>;
  transitionConcernStatus(
    id: string,
    options: ActiveConcernTransitionOptions,
  ): Awaitable<ActiveConcern | null>;
  resolveStaleConcerns(options?: ActiveConcernStaleResolutionOptions): Awaitable<ActiveConcern[]>;
}

export interface ConcernStorePort {
  create(input: ActiveConcernCreateInput): Promise<ActiveConcern>;
  getById(id: string): Promise<ActiveConcern | null>;
  getActiveConcerns(contactId?: string): Promise<ActiveConcern[]>;
  list(options?: ActiveConcernListOptions): Promise<ActiveConcern[]>;
  listRecentlyResolvedConcerns(
    contactId?: string,
    options?: ActiveConcernRecentResolutionOptions,
  ): Promise<ActiveConcern[]>;
  findRecentlyResolvedSimilarConcern(input: {
    text: string;
    contactId?: string;
    withinMs?: number;
    asOf?: string;
  }): Promise<ActiveConcern | null>;
  resolveConcern(id: string, options?: ActiveConcernResolveOptions): Promise<ActiveConcern | null>;
  transitionConcernStatus(
    id: string,
    options: ActiveConcernTransitionOptions,
  ): Promise<ActiveConcern | null>;
  resolveStaleConcerns(options?: ActiveConcernStaleResolutionOptions): Promise<ActiveConcern[]>;
}

export function createConcernStorePort(store: ConcernStorePortBackend): ConcernStorePort {
  return {
    create: async (input) => await store.create(input),
    getById: async (id) => await store.getById(id),
    getActiveConcerns: async (contactId) => await store.getActiveConcerns(contactId),
    list: async (options) => await store.list(options),
    listRecentlyResolvedConcerns: async (contactId, options) => (
      await store.listRecentlyResolvedConcerns(contactId, options)
    ),
    findRecentlyResolvedSimilarConcern: async (input) => (
      await store.findRecentlyResolvedSimilarConcern(input)
    ),
    resolveConcern: async (id, options) => await store.resolveConcern(id, options),
    transitionConcernStatus: async (id, options) => await store.transitionConcernStatus(id, options),
    resolveStaleConcerns: async (options) => await store.resolveStaleConcerns(options),
  };
}
