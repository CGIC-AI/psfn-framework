import type {
  ActiveConcern,
  ActiveConcernListOptions,
  ActiveConcernStaleResolutionOptions,
  ActiveConcernTransitionOptions,
} from '../../../../core/intention/concerns.js';

export interface AdminConcernListData {
  concerns: ActiveConcern[];
}

export interface AdminConcernMutationResult {
  ok: boolean;
  concerns: ActiveConcern[];
  message?: string;
}

export interface AdminConcernService {
  listConcerns(options?: ActiveConcernListOptions): Promise<AdminConcernListData>;
  resolveConcern(
    id: string,
    options?: { outcome?: string; evidenceRef?: string },
  ): Promise<AdminConcernMutationResult>;
  suppressConcern(
    id: string,
    options?: { outcome?: string; evidenceRef?: string },
  ): Promise<AdminConcernMutationResult>;
  transitionConcern(
    id: string,
    options: ActiveConcernTransitionOptions,
  ): Promise<AdminConcernMutationResult>;
  resolveStaleConcerns(
    options?: ActiveConcernStaleResolutionOptions,
  ): Promise<AdminConcernMutationResult>;
}
