import { describe, expect, it, vi } from 'vitest';
import { createWebFetchTool } from './tools.js';

describe('web tools', () => {
  it('fetches content through the provided operations', async () => {
    const ops = {
      fetch: vi.fn(async () => '# page'),
    };

    const tool = createWebFetchTool(ops);
    const result = await tool.execute('call-1', {
      url: 'https://example.com',
      lane: 'local_crawler',
      prompt: 'Focus on main content',
    });

    expect(ops.fetch).toHaveBeenCalledWith('https://example.com', {
      lane: 'local_crawler',
      prompt: 'Focus on main content',
    });
    expect(result.details).toEqual({});
    expect(result.content).toEqual([{ type: 'text', text: '# page' }]);
  });

  it('returns an error result when the fetch fails', async () => {
    const ops = {
      fetch: vi.fn(async () => {
        throw new Error('blocked');
      }),
    };

    const tool = createWebFetchTool(ops);
    const result = await tool.execute('call-2', {
      url: 'https://example.com',
    });

    expect(result.details).toEqual({ isError: true });
    expect(result.content).toEqual([{ type: 'text', text: 'web_fetch failed: blocked' }]);
  });
});
