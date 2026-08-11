import { describe, expect, it, vi } from 'vitest';
import { persistEmotionalStateFromExtraction } from './emotional.js';

describe('persistEmotionalStateFromExtraction', () => {
  it('rejects a testing-session observation before the contact persistence boundary', async () => {
    const contactStore = {
      updateEmotionalBaseline: vi.fn(),
    };

    await expect(persistEmotionalStateFromExtraction({
      sourceSessionId: 'api:testing:emotion-persistence',
      canonicalContactId: 'contact-testing',
      acceptedFacts: [{
        text: 'Example Person felt relieved after the deployment completed.',
        type: 'emotional',
        importance: 0.9,
        emotionalValence: 0.8,
        confidence: 0.95,
        tags: ['emotion'],
      }],
      recentEntries: [{
        id: 1,
        channelId: 'api:testing:emotion-persistence',
        role: 'user',
        content: 'I feel relieved after the deployment completed.',
        timestamp: 1_000,
      }],
      contactStore: contactStore as never,
      telemetryEnabled: true,
    })).resolves.toBeUndefined();

    expect(contactStore.updateEmotionalBaseline).not.toHaveBeenCalled();
  });
});
