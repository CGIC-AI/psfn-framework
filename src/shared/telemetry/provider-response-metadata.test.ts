import { describe, expect, it } from 'vitest';
import {
  extractProviderResponseMetadata,
  mergeProviderResponseMetadata,
  providerResponseLogMetadata,
} from './provider-response-metadata.js';

describe('provider response metadata', () => {
  it('rejects credential-shaped, unbounded and malformed values without copying response content', () => {
    expect(extractProviderResponseMetadata({
      id: 'sk-or-private-credential-value',
      provider: 'x'.repeat(300),
      choices: [{ message: { content: 'private response' } }],
    })).toEqual({ conflicts: ['responseId', 'servingProvider'] });
    expect(extractProviderResponseMetadata({ id: {}, provider: ['Together'] }))
      .toEqual({ conflicts: ['responseId', 'servingProvider'] });
    expect(extractProviderResponseMetadata({ choices: [] })).toBeUndefined();
  });

  it('never resolves conflicting response IDs by preferring the SDK or a later chunk', () => {
    const conflict = mergeProviderResponseMetadata(
      { responseId: 'gen-sdk', servingProvider: 'Together' },
      { responseId: 'gen-wire' },
    );
    expect(mergeProviderResponseMetadata(conflict, { responseId: 'gen-sdk' })).toEqual({
      servingProvider: 'Together', conflicts: ['responseId'],
    });
    expect(providerResponseLogMetadata(conflict)).toEqual({
      servingProvider: 'Together', providerResponseConflict: true,
    });
  });
});
