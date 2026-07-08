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

  it('returns structured invalid-input metadata when the unified tool input is incomplete', async () => {
    const ops = {
      fetch: vi.fn(),
    };

    const tool = createWebTool(ops);
    const result = await tool.execute('call-3', {});

    expect(ops.fetch).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      isError: true,
      errorClass: 'invalid_input',
      retryHint: 'try_alternative_input',
      retryable: false,
      rawDiagnostic: 'target is required.',
    });
    expect(result.content).toEqual([{
      type: 'text',
      text: 'web failed: Invalid input: target is required.',
    }]);
  });

  it('returns structured retryable metadata when the unified tool backend is unavailable', async () => {
    const ops = {
      fetch: vi.fn(async () => {
        const error = new Error('Fetch failed: 503 Service Unavailable') as Error & { code: number };
        error.code = -32003;
        throw error;
      }),
    };

    const tool = createWebTool(ops);
    const result = await tool.execute('call-4', {
      target: 'https://example.com',
    });

    expect(result.details).toMatchObject({
      isError: true,
      errorClass: 'unavailable',
      retryHint: 'retry_with_backoff',
      retryable: true,
      rawDiagnostic: 'Fetch failed: 503 Service Unavailable',
    });
    expect(result.content).toEqual([{
      type: 'text',
      text: 'web failed: Service unavailable: Fetch failed: 503 Service Unavailable',
    }]);
  });

  it('annotates web_fetch private-IP policy blocks without leaking secret URL params', async () => {
    const ops = {
      fetch: vi.fn(async () => {
        const error = new Error(
          'URL blocked: resolved address is cloud metadata for http://169.254.169.254/latest?token=secret-value',
        ) as Error & { code: number };
        error.code = -32002;
        throw error;
      }),
    };

    const tool = createWebFetchTool(ops);
    const result = await tool.execute('call-5', {
      url: 'https://example.com',
    });

    expect(result.details).toMatchObject({
      isError: true,
      errorClass: 'policy_blocked',
      retryHint: 'try_alternative_input',
      retryable: false,
    });
    expect((result.details as any).rawDiagnostic).toContain('cloud metadata');
    expect((result.details as any).rawDiagnostic).not.toContain('secret-value');
    expect((result.content[0] as { text: string }).text).toContain('web_fetch failed: Blocked by runtime policy');
    expect((result.content[0] as { text: string }).text).not.toContain('secret-value');
  });
});
