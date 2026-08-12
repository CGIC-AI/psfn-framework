import { describe, expect, it, vi } from 'vitest';

import type { GardenRequestContext } from '../garden-request-context.js';
import { createGardenAutomataLessonReviewPort } from './automata-lesson-review-adapter.js';

describe('createGardenAutomataLessonReviewPort', () => {
  it('delegates only to the authenticated governed proposal operation', async () => {
    const context = { kind: 'fleet_principal' } as GardenRequestContext;
    const propose = vi.fn(() => ({ reviewId: 'review-1', status: 'pending' as const }));
    const port = createGardenAutomataLessonReviewPort({ service: { propose }, context });
    const request = {
      artifactPath: 'automata/lesson-proposals/example.json',
      content: '{}',
      mediaType: 'application/json' as const,
      provenance: 'automata-lesson:example',
    };

    await expect(port.propose(request)).resolves.toEqual({ reviewId: 'review-1', status: 'pending' });
    expect(propose).toHaveBeenCalledExactlyOnceWith(context, request);
  });
});
