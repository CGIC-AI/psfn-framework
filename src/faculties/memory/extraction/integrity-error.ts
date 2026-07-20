import type { TurnID } from '../../../shared/contracts/runtime.js';
import type { ExtractedFact } from '../types.js';
import type { ExtractionTriggerReason } from './types.js';

export type ExtractionIntegrityErrorStage = 'orchestration' | 'fact_processing';

export interface ExtractionIntegrityErrorContext {
  stage: ExtractionIntegrityErrorStage;
  channelId: string;
  triggerReason: ExtractionTriggerReason;
  turnId?: TurnID;
  factIndex?: number;
  factType?: ExtractedFact['type'];
  sourceRef?: string;
}

export class ExtractionIntegrityError extends Error {
  readonly context: ExtractionIntegrityErrorContext;
  readonly cause: unknown;

  constructor(message: string, context: ExtractionIntegrityErrorContext, cause: unknown) {
    super(message);
    this.name = 'ExtractionIntegrityError';
    this.context = context;
    this.cause = cause;
  }
}
