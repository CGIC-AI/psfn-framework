import rawImageModelCatalog from './model-catalog.json';
import { isRecord } from '../../shared/utils/types.js';

interface ImageModelCatalog {
  schemaVersion: 1;
  createModels: readonly string[];
  editModels: readonly string[];
  defaultCreateModelChain: readonly string[];
  defaultEditModelChain: readonly string[];
  selfieEditModelChain: readonly string[];
}

function readStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid image model catalog: ${key} must be a non-empty string array`);
  }
  const values = value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`Invalid image model catalog: ${key}[${String(index)}] must be a non-empty string`);
    }
    return entry.trim();
  });
  const unique = new Set(values);
  if (unique.size !== values.length) {
    throw new Error(`Invalid image model catalog: ${key} contains duplicate entries`);
  }
  return values;
}

function assertChainInCatalog(
  chain: readonly string[],
  catalog: ReadonlySet<string>,
  chainKey: string,
  catalogKey: string,
): void {
  for (const [index, model] of chain.entries()) {
    if (!catalog.has(model)) {
      throw new Error(
        `Invalid image model catalog: ${chainKey}[${String(index)}] references "${model}" outside ${catalogKey}`,
      );
    }
  }
}

function loadImageModelCatalog(raw: unknown): ImageModelCatalog {
  if (!isRecord(raw)) {
    throw new Error('Invalid image model catalog: root must be a JSON object');
  }
  if (raw.schemaVersion !== 1) {
    throw new Error('Invalid image model catalog: schemaVersion must be 1');
  }

  const createModels = readStringArray(raw, 'createModels');
  const editModels = readStringArray(raw, 'editModels');
  const defaultCreateModelChain = readStringArray(raw, 'defaultCreateModelChain');
  const defaultEditModelChain = readStringArray(raw, 'defaultEditModelChain');
  const selfieEditModelChain = readStringArray(raw, 'selfieEditModelChain');

  const createModelSet = new Set(createModels);
  const editModelSet = new Set(editModels);
  assertChainInCatalog(defaultCreateModelChain, createModelSet, 'defaultCreateModelChain', 'createModels');
  assertChainInCatalog(defaultEditModelChain, editModelSet, 'defaultEditModelChain', 'editModels');
  assertChainInCatalog(selfieEditModelChain, editModelSet, 'selfieEditModelChain', 'editModels');

  return Object.freeze({
    schemaVersion: 1,
    createModels: Object.freeze([...createModels]),
    editModels: Object.freeze([...editModels]),
    defaultCreateModelChain: Object.freeze([...defaultCreateModelChain]),
    defaultEditModelChain: Object.freeze([...defaultEditModelChain]),
    selfieEditModelChain: Object.freeze([...selfieEditModelChain]),
  });
}

export const IMAGE_MODEL_CATALOG = loadImageModelCatalog(rawImageModelCatalog);
