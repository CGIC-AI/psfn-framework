import type { LLMUsageDetails } from '../contracts/runtime.js';

/** A provider attempt failed validation after returning billable usage evidence. */
export class ProviderResponseValidationError extends Error {
  readonly usageDetails?: LLMUsageDetails;

  constructor(message: string, usageDetails?: LLMUsageDetails) {
    super(message);
    this.name = 'ProviderResponseValidationError';
    this.usageDetails = usageDetails;
  }
}

export function extractProviderAttemptUsageDetails(error: unknown): LLMUsageDetails | undefined {
  return error instanceof ProviderResponseValidationError
    ? error.usageDetails
    : undefined;
}
