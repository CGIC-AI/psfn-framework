import { describe, expect, it, vi } from 'vitest';

import type { LetterService } from '../letters/service.js';
import { createLetterTool } from './letter.js';
import { resolveToolCapabilityRequirement } from '../../system/capabilities/requirements.js';

function serviceStub(): LetterService {
  return {
    compose: vi.fn(async input => ({ id: 'letter-1', ...input, state: 'placed' })),
    list: vi.fn(async () => []),
    read: vi.fn(async () => ({ id: 'letter-1', state: 'read' })),
    place: vi.fn(async () => ({ id: 'letter-1', state: 'placed' })),
    archive: vi.fn(async () => ({ id: 'letter-1', state: 'archived' })),
  } as unknown as LetterService;
}

describe('letter tool', () => {
  it('authors only as the companion and places by default', async () => {
    const service = serviceStub();
    const result = await createLetterTool(service).execute('call-1', {
      action: 'compose', subject: 'Hello', body: 'For later.',
    });

    expect(service.compose).toHaveBeenCalledWith({
      author: 'companion', recipient: 'partner', subject: 'Hello', body: 'For later.',
    });
    expect(result.content[0]).toMatchObject({ type: 'text' });
  });

  it('reads only as the companion recipient', async () => {
    const service = serviceStub();
    await createLetterTool(service).execute('call-1', { action: 'read', letterId: 'letter-1' });
    expect(service.read).toHaveBeenCalledWith('letter-1', 'companion');
  });

  it('keeps state-changing read actions behind the runtime-write capability', () => {
    const tool = createLetterTool(serviceStub());
    expect(resolveToolCapabilityRequirement(tool, { action: 'list' }))
      .toEqual({ declared: true, tokens: ['identity.read'] });
    expect(resolveToolCapabilityRequirement(tool, { action: 'read', letterId: 'letter-1' }))
      .toEqual({ declared: true, tokens: ['identity.write.runtime'] });
  });
});
