import { createComponentLogger } from '../../shared/logger.js';
import { ModelBudgetExceededError } from '../../primitives/llm/model-budget.js';

const log = createComponentLogger('MemoryPipelineBudgetDeferral');

/**
 * The model-budget refusal carried anywhere in `error`'s cause chain, if any
 * (psfn-framework-zwwo0). The budget preflight refuses a call before anything
 * is dispatched, so a refusal says nothing about the unit of work that asked:
 * a memory pipeline defers that unit instead of charging it a bounded attempt.
 * Agent-side lanes see the same type because the gateway client rebuilds it
 * from the typed RPC error.
 */
export function findModelBudgetRefusal(error: unknown): ModelBudgetExceededError | undefined {
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof ModelBudgetExceededError) return current;
    visited.add(current);
    current = current.cause;
  }
  return undefined;
}

/**
 * Edge-triggered visibility for one pipeline's budget deferrals: one warning
 * when the first refusal opens a blocked window, one line when work is admitted
 * again, and nothing per refused attempt in between. The budget layer already
 * reports every refusal through its own blocked events and operator alerts.
 */
export class ModelRefusalDeferralWindow {
  private openedAtMs: number | null = null;
  private refusals = 0;

  constructor(
    private readonly pipeline: 'episode_synthesis' | 'group_extraction',
    private readonly now: () => number,
  ) {}

  noteRefusal(refusal: ModelBudgetExceededError, fields: Record<string, unknown> = {}): void {
    this.refusals += 1;
    if (this.openedAtMs !== null) return;
    this.openedAtMs = this.now();
    log.warn('Memory pipeline deferred: the model budget refuses its calls before dispatch; no attempt is consumed', {
      pipeline: this.pipeline,
      deferral: 'model_budget',
      reason: refusal.event.reason,
      provider: refusal.event.provider,
      model: refusal.event.model,
      ...fields,
    });
  }

  noteAdmitted(): void {
    if (this.openedAtMs === null) return;
    log.info('Memory pipeline resumed after a model-budget deferral', {
      pipeline: this.pipeline,
      deferral: 'model_budget',
      deferredForMs: Math.max(0, this.now() - this.openedAtMs),
      refusedAttempts: this.refusals,
    });
    this.openedAtMs = null;
    this.refusals = 0;
  }
}
