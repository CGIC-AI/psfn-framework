import { describe, expect, it, vi } from 'vitest';
import { createWebFetchTool, createWebTool } from './tools.js';

describe('web tools', () => {
  it('fetches content through the unified fetch action', async () => {
    const ops = {
      fetch: vi.fn(async () => '# page'),
    };

    const tool = createWebTool(ops);
    const result = await tool.execute('call-1', {
      target: 'https://example.com',
      prompt: 'Focus on main content',
    });

    expect(ops.fetch).toHaveBeenCalledWith('https://example.com', {
      prompt: 'Focus on main content',
    });
    expect(result.details).toEqual({});
    expect(result.content).toEqual([{ type: 'text', text: '# page' }]);
  });

  it('uses the crawler lane for the browse action', async () => {
    const ops = {
      fetch: vi.fn(async () => '# page'),
    };

    const tool = createWebTool(ops);
    const result = await tool.execute('call-1', {
      action: 'browse',
      target: 'https://example.com',
      prompt: 'Focus on main content',
    });

    expect(ops.fetch).toHaveBeenCalledWith('https://example.com', {
      lane: 'local_crawler',
      prompt: 'Focus on main content',
    });
    expect(result.details).toEqual({});
    expect(result.content).toEqual([{ type: 'text', text: '# page' }]);
  });

  it('runs search discovery and fetches the planned URLs', async () => {
    const ops = {
      fetch: vi.fn(async (url: string) => `content for ${url}`),
    };
    const queryJson = vi.fn(async () => [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/a',
      'http://ignored.example.com',
    ]);

    const tool = createWebTool(ops, queryJson);
    const result = await tool.execute('call-2', {
      action: 'search',
      target: 'test query',
      max_urls: 2,
    });

    expect(queryJson).toHaveBeenCalledTimes(1);
    expect(ops.fetch).toHaveBeenCalledTimes(2);
    expect(ops.fetch).toHaveBeenNthCalledWith(1, 'https://example.com/a', {
      lane: 'local_crawler',
      prompt: 'Research query: test query',
    });
    expect(ops.fetch).toHaveBeenNthCalledWith(2, 'https://example.com/b', {
      lane: 'local_crawler',
      prompt: 'Research query: test query',
    });
    expect(result.content).toEqual([{
      type: 'text',
      text: JSON.stringify({
        action: 'search',
        query: 'test query',
        count: 2,
        results: [
          { url: 'https://example.com/a', content: 'content for https://example.com/a' },
          { url: 'https://example.com/b', content: 'content for https://example.com/b' },
        ],
      }, null, 2),
    }]);
  });

  it('returns an error result when the unified tool fails', async () => {
    const ops = {
      fetch: vi.fn(async () => {
        throw new Error('blocked');
      }),
    };

    const tool = createWebTool(ops);
    const result = await tool.execute('call-3', {
      target: 'https://example.com',
    });

    expect(result.details).toEqual({ isError: true });
    expect(result.content).toEqual([{ type: 'text', text: 'web failed: blocked' }]);
  });

  it('keeps the legacy web_fetch alias behavior intact', async () => {
    const ops = {
      fetch: vi.fn(async () => {
        throw new Error('blocked');
      }),
    };

    const tool = createWebFetchTool(ops);
    const result = await tool.execute('call-4', {
      url: 'https://example.com',
    });

    expect(result.details).toEqual({ isError: true });
    expect(result.content).toEqual([{ type: 'text', text: 'web_fetch failed: blocked' }]);
  });
});
