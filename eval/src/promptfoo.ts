import { isRecord } from '../../src/shared/utils/types.js';
import promptfooBaseConfigJson from '../promptfooconfig.base.json' with { type: 'json' };

type PromptfooPrimitive = boolean | number | string | null;

export type PromptfooValue =
  | PromptfooPrimitive
  | PromptfooValue[]
  | { [key: string]: PromptfooValue };

export interface PromptfooProviderReference {
  id: string;
  label?: string;
  config?: Record<string, PromptfooValue>;
}

export interface PromptfooAssertion {
  type: string;
  value?: PromptfooValue;
}

export interface PromptfooTestCase {
  description?: string;
  vars?: Record<string, PromptfooValue>;
  assert?: PromptfooAssertion[];
  metadata?: Record<string, PromptfooValue>;
  tags?: string[];
}

export interface PromptfooConfig {
  description: string;
  prompts: string[];
  providers: Array<string | PromptfooProviderReference>;
  tests?: string | PromptfooTestCase[];
  defaultTest?: Partial<PromptfooTestCase>;
}

export const PROMPTFOO_BASE_CONFIG = promptfooBaseConfigJson satisfies PromptfooConfig;

assertPromptfooConfig(PROMPTFOO_BASE_CONFIG);

export function assertPromptfooConfig(
  value: unknown,
): asserts value is PromptfooConfig {
  if (!isRecord(value)) {
    throw new Error('Promptfoo config must be an object');
  }

  if (typeof value.description !== 'string' || value.description.trim().length === 0) {
    throw new Error('Promptfoo config description must be a non-empty string');
  }

  if (!isStringArray(value.prompts, { allowEmpty: false })) {
    throw new Error('Promptfoo config prompts must be a non-empty string array');
  }

  if (!Array.isArray(value.providers)) {
    throw new Error('Promptfoo config providers must be an array');
  }
  for (let index = 0; index < value.providers.length; index += 1) {
    const provider = value.providers[index];
    if (typeof provider === 'string') continue;
    if (!isRecord(provider) || typeof provider.id !== 'string' || provider.id.trim().length === 0) {
      throw new Error(`Promptfoo config providers[${index}] must be a string or provider reference`);
    }
  }

  if (
    value.tests !== undefined
    && typeof value.tests !== 'string'
    && !Array.isArray(value.tests)
  ) {
    throw new Error('Promptfoo config tests must be a string path or array of test cases');
  }

  if (value.defaultTest !== undefined && !isRecord(value.defaultTest)) {
    throw new Error('Promptfoo config defaultTest must be an object when provided');
  }
}


function isStringArray(
  value: unknown,
  options: { allowEmpty: boolean },
): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  if (!options.allowEmpty && value.length === 0) {
    return false;
  }
  return value.every(entry => typeof entry === 'string' && entry.trim().length > 0);
}
