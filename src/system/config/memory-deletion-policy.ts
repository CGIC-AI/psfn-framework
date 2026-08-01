import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';

const JUSTIFICATION_CATEGORY_ID = /^[a-z][a-z0-9_]{1,63}$/u;

export interface MemoryDeletionJustificationCategory {
  id: string;
  label: string;
  eligible: boolean;
  /** Case-insensitive phrases that substantiate (eligible) or identify (ineligible) this category. */
  explanationPatterns: string[];
  refusalReason?: string;
}

export interface MemoryDeletionPolicy {
  justificationCategories: MemoryDeletionJustificationCategory[];
}

function requiredTrimmedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeMemoryDeletionPolicy(
  value: unknown,
  fieldPath = 'memoryDeletionPolicy',
): MemoryDeletionPolicy {
  if (!isRecord(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(value, ['justificationCategories'], fieldPath);
  if (!Array.isArray(value.justificationCategories) || value.justificationCategories.length === 0) {
    throw new Error(`${fieldPath}.justificationCategories must be a non-empty array`);
  }

  const seen = new Set<string>();
  const justificationCategories = value.justificationCategories.map((entry, index) => {
    const categoryPath = `${fieldPath}.justificationCategories[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${categoryPath} must be an object`);
    }
    assertNoUnknownKeys(
      entry,
      ['id', 'label', 'eligible', 'explanationPatterns', 'refusalReason'],
      categoryPath,
    );
    const id = requiredTrimmedString(entry.id, `${categoryPath}.id`);
    if (!JUSTIFICATION_CATEGORY_ID.test(id)) {
      throw new Error(`${categoryPath}.id must match ${JUSTIFICATION_CATEGORY_ID.source}`);
    }
    if (seen.has(id)) {
      throw new Error(`${fieldPath}.justificationCategories contains duplicate id "${id}"`);
    }
    seen.add(id);
    const label = requiredTrimmedString(entry.label, `${categoryPath}.label`);
    if (typeof entry.eligible !== 'boolean') {
      throw new Error(`${categoryPath}.eligible must be a boolean`);
    }
    if (!Array.isArray(entry.explanationPatterns) || entry.explanationPatterns.length === 0) {
      throw new Error(`${categoryPath}.explanationPatterns must be a non-empty array`);
    }
    const explanationPatterns = entry.explanationPatterns.map((pattern, patternIndex) => (
      requiredTrimmedString(pattern, `${categoryPath}.explanationPatterns[${patternIndex}]`).toLocaleLowerCase()
    ));
    if (new Set(explanationPatterns).size !== explanationPatterns.length) {
      throw new Error(`${categoryPath}.explanationPatterns must not contain duplicates`);
    }
    const refusalReason = entry.refusalReason === undefined
      ? undefined
      : requiredTrimmedString(entry.refusalReason, `${categoryPath}.refusalReason`);
    if (!entry.eligible && !refusalReason) {
      throw new Error(`${categoryPath}.refusalReason is required when eligible=false`);
    }
    return {
      id,
      label,
      eligible: entry.eligible,
      explanationPatterns,
      ...(refusalReason ? { refusalReason } : {}),
    };
  });

  return { justificationCategories };
}

export function cloneMemoryDeletionPolicy(policy: MemoryDeletionPolicy): MemoryDeletionPolicy {
  return normalizeMemoryDeletionPolicy(structuredClone(policy));
}

export function resolveMemoryDeletionJustification(
  policy: MemoryDeletionPolicy | undefined,
  categoryId: string,
  explanation: string,
): MemoryDeletionJustificationCategory {
  if (!policy) {
    throw new Error('Memory deletion proposals are unavailable: memoryDeletionPolicy is not configured in settings.json');
  }
  const normalized = normalizeMemoryDeletionPolicy(policy);
  const category = normalized.justificationCategories.find(entry => entry.id === categoryId);
  if (!category) {
    throw new Error(`Unknown memory deletion justification category "${categoryId}"`);
  }
  if (!category.eligible) {
    throw new Error(category.refusalReason ?? `Memory deletion justification category "${categoryId}" is insufficient`);
  }
  const normalizedExplanation = requiredTrimmedString(
    explanation,
    'Memory deletion proposal explanation',
  ).toLocaleLowerCase();
  const selectedCategoryIsSubstantiated = category.explanationPatterns.some(pattern => (
    normalizedExplanation.includes(pattern)
  ));
  const matchedInsufficientCategory = normalized.justificationCategories.find(entry => (
    !entry.eligible
    && entry.explanationPatterns.some(pattern => normalizedExplanation.includes(pattern))
  ));
  if (matchedInsufficientCategory && !selectedCategoryIsSubstantiated) {
    throw new Error(
      matchedInsufficientCategory.refusalReason
      ?? `Memory deletion explanation expresses only insufficient category "${matchedInsufficientCategory.id}"`,
    );
  }
  return category;
}
