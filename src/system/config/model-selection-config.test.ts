import { describe, expect, it } from 'vitest';
import type { CanonicalModelRegistry } from '../../shared/contracts/runtime.js';
import {
  assertModelPurposeSelectionResolvable,
  listEnabledModelRegistrySlotKeys,
  normalizeModelPurposeSelectionSetting,
} from './model-selection-config.js';

function makeRegistry(): CanonicalModelRegistry {
  return {
    schemaVersion: 1,
    models: [
      {
        id: 'chat-primary',
        rank: 10,
        identity: { provider: 'openrouter', model: 'chat/model', source: { type: 'openrouter' } },
        purposes: [{ purpose: 'chat', primary: true }],
        capabilities: { maxOutputTokens: 8192, contextWindow: 128_000 },
      },
      {
        id: 'background-primary',
        rank: 20,
        identity: { provider: 'openrouter', model: 'background/model', source: { type: 'openrouter' } },
        purposes: [{ purpose: 'background', primary: true }],
        capabilities: { maxOutputTokens: 2048, contextWindow: 64_000 },
      },
      {
        id: 'disabled-model',
        enabled: false,
        rank: 30,
        identity: { provider: 'openrouter', model: 'disabled/model', source: { type: 'openrouter' } },
        purposes: [{ purpose: 'chat', primary: false }],
        capabilities: { maxOutputTokens: 2048, contextWindow: 64_000 },
      },
    ],
  };
}

describe('normalizeModelPurposeSelectionSetting', () => {
  it('returns undefined for null/undefined (clearing the setting)', () => {
    expect(normalizeModelPurposeSelectionSetting(undefined)).toBeUndefined();
    expect(normalizeModelPurposeSelectionSetting(null)).toBeUndefined();
  });

  it('returns undefined for an empty object', () => {
    expect(normalizeModelPurposeSelectionSetting({})).toBeUndefined();
  });

  it('normalizes trimmed purpose keys and slot keys', () => {
    expect(normalizeModelPurposeSelectionSetting({
      chat: ' chat-primary ',
      vision: 'vision.slot_1',
    })).toEqual({
      chat: 'chat-primary',
      vision: 'vision.slot_1',
    });
  });

  it('drops null-valued purposes (per-purpose clears)', () => {
    expect(normalizeModelPurposeSelectionSetting({
      chat: 'chat-primary',
      vision: null,
    })).toEqual({ chat: 'chat-primary' });
  });

  it('rejects non-object values fail-closed', () => {
    expect(() => normalizeModelPurposeSelectionSetting('chat-primary')).toThrow(
      /modelPurposeSelection must be an object/,
    );
    expect(() => normalizeModelPurposeSelectionSetting(['chat-primary'])).toThrow(
      /modelPurposeSelection/,
    );
  });

  it('rejects unknown purpose keys with the valid purpose list', () => {
    expect(() => normalizeModelPurposeSelectionSetting({ bigBrain: 'chat-primary' })).toThrow(
      /unknown model purpose "bigBrain".*chat.*vision/s,
    );
  });

  it('rejects empty and malformed slot keys', () => {
    expect(() => normalizeModelPurposeSelectionSetting({ chat: '' })).toThrow(
      /modelPurposeSelection\.chat must be a non-empty/,
    );
    expect(() => normalizeModelPurposeSelectionSetting({ chat: 42 })).toThrow(
      /modelPurposeSelection\.chat/,
    );
    expect(() => normalizeModelPurposeSelectionSetting({ chat: 'bad slot/key' })).toThrow(
      /characters outside/,
    );
  });
});

describe('assertModelPurposeSelectionResolvable', () => {
  it('accepts an absent selection (byte-identical default path)', () => {
    expect(() => assertModelPurposeSelectionResolvable({
      modelRegistry: makeRegistry(),
    })).not.toThrow();
  });

  it('accepts selections that resolve to enabled registry entries', () => {
    expect(() => assertModelPurposeSelectionResolvable({
      modelPurposeSelection: { chat: 'background-primary', vision: 'chat-primary' },
      modelRegistry: makeRegistry(),
    })).not.toThrow();
  });

  it('rejects unknown slot keys with the valid slot list', () => {
    expect(() => assertModelPurposeSelectionResolvable({
      modelPurposeSelection: { chat: 'no-such-slot' },
      modelRegistry: makeRegistry(),
    })).toThrow(/modelPurposeSelection\.chat.*"no-such-slot".*chat-primary, background-primary/s);
  });

  it('rejects selections that target disabled registry entries', () => {
    expect(() => assertModelPurposeSelectionResolvable({
      modelPurposeSelection: { chat: 'disabled-model' },
      modelRegistry: makeRegistry(),
    })).toThrow(/not an enabled models\.json registry entry/);
  });

  it('rejects any selection when the registry is absent (fail closed, never silent)', () => {
    expect(() => assertModelPurposeSelectionResolvable({
      modelPurposeSelection: { chat: 'chat-primary' },
    })).toThrow(/none — models\.json registry is empty/);
  });
});

describe('listEnabledModelRegistrySlotKeys', () => {
  it('lists enabled entries only', () => {
    expect(listEnabledModelRegistrySlotKeys({ modelRegistry: makeRegistry() }))
      .toEqual(['chat-primary', 'background-primary']);
  });
});
