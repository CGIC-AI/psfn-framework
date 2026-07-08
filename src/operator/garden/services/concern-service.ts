import type { ConcernStorePort } from '../../../core/intention/concern-store-port.js';
import type {
  ActiveConcern,
  ActiveConcernEvidenceRef,
  ActiveConcernListOptions,
  ActiveConcernResolveOptions,
  ActiveConcernStaleResolutionOptions,
  ActiveConcernTransitionOptions,
} from '../../../core/intention/concerns.js';
import type {
  AdminConcernListData,
  AdminConcernMutationResult,
  AdminConcernService,
} from './types.js';

function operatorEvidenceRef(ref: string | undefined): ActiveConcernEvidenceRef[] | undefined {
  const normalized = typeof ref === 'string' ? ref.trim() : '';
  if (!normalized) return undefined;
  return [{ kind: 'operator', ref: normalized }];
}

function mutationResult(concern: ActiveConcern | null, missingMessage: string): AdminConcernMutationResult {
  if (!concern) {
    return {
      ok: false,
      concerns: [],
      message: missingMessage,
    };
  }
  return {
    ok: true,
    concerns: [concern],
  };
}

export class AdminConcernDataService implements AdminConcernService {
  constructor(private readonly concernStore: ConcernStorePort) {}

  async listConcerns(options: ActiveConcernListOptions = {}): Promise<AdminConcernListData> {
    return {
      concerns: await this.concernStore.list(options),
    };
  }

  async resolveConcern(
    id: string,
    options: { outcome?: string; evidenceRef?: string } = {},
  ): Promise<AdminConcernMutationResult> {
    const resolveOptions: ActiveConcernResolveOptions = {};
    if (options.outcome) resolveOptions.outcome = options.outcome;
    const evidenceRefs = operatorEvidenceRef(options.evidenceRef);
    if (evidenceRefs) resolveOptions.evidenceRefs = evidenceRefs;

    return mutationResult(
      await this.concernStore.resolveConcern(id, resolveOptions),
      'Concern not found or already terminal',
    );
  }

  async suppressConcern(
    id: string,
    options: { outcome?: string; evidenceRef?: string } = {},
  ): Promise<AdminConcernMutationResult> {
    const transitionOptions: ActiveConcernTransitionOptions = {
      status: 'suppressed',
      outcome: options.outcome ?? 'Suppressed by operator.',
    };
    const evidenceRefs = operatorEvidenceRef(options.evidenceRef);
    if (evidenceRefs) {
      transitionOptions.evidenceRefs = evidenceRefs;
      transitionOptions.resolutionEvidenceRefs = evidenceRefs;
    }

    return mutationResult(
      await this.concernStore.transitionConcernStatus(id, transitionOptions),
      'Concern not found or cannot be suppressed',
    );
  }

  async transitionConcern(
    id: string,
    options: ActiveConcernTransitionOptions,
  ): Promise<AdminConcernMutationResult> {
    return mutationResult(
      await this.concernStore.transitionConcernStatus(id, options),
      'Concern not found or transition was rejected',
    );
  }

  async resolveStaleConcerns(
    options: ActiveConcernStaleResolutionOptions = {},
  ): Promise<AdminConcernMutationResult> {
    const concerns = await this.concernStore.resolveStaleConcerns(options);
    return {
      ok: true,
      concerns,
    };
  }
}
