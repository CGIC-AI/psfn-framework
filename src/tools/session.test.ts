import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readLastActiveSession,
  writeLastActiveSession,
} from '../lifecycle/notifications.js';
import { createSessionNewTool } from './session.js';

function extractText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(part => part.text).join('');
}

describe('session_new tool', () => {
  it('exposes expected metadata', () => {
    const tool = createSessionNewTool({ dataDir: '/tmp' });
    expect(tool.name).toBe('session_new');
    expect(tool.label).toBe('session_new');
    expect(tool.description.toLowerCase()).toContain('session');
    expect(tool.parameters).toBeDefined();
  });

  it('creates a new session and switches active context', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'session-new-tool-'));
    try {
      writeLastActiveSession(dataDir, {
        sessionId: 'discord:old-session',
        channelType: 'discord',
        timestamp: 1_700_000_000_000,
      });

      const seeded: string[] = [];
      const tool = createSessionNewTool({
        dataDir,
        now: () => 1_700_000_000_123,
        idFactory: () => 'api:session-test-01',
        seedSession: (sessionId) => {
          seeded.push(sessionId);
        },
      });

      const result = await tool.execute('call-1', {});
      const details = result.details as {
        previousSessionId: string | null;
        newSessionId: string;
        newChannelType: string;
        switched: boolean;
      };

      expect(extractText(result as any)).toContain('session_new: active context switched');
      expect(details.previousSessionId).toBe('discord:old-session');
      expect(details.newSessionId).toBe('api:session-test-01');
      expect(details.newChannelType).toBe('api');
      expect(details.switched).toBe(true);
      expect(seeded).toEqual(['api:session-test-01']);

      const active = readLastActiveSession(dataDir);
      expect(active?.sessionId).toBe('api:session-test-01');
      expect(active?.channelType).toBe('api');
      expect(active?.timestamp).toBe(1_700_000_000_123);
    } finally {
      await new Promise(resolve => setTimeout(resolve, 5));
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('accepts previous session hint via metadata', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'session-new-tool-metadata-'));
    try {
      const tool = createSessionNewTool({
        dataDir,
        now: () => 1_700_000_000_500,
        idFactory: () => 'api:session-test-02',
      });

      const result = await tool.execute('call-2', {
        metadata: {
          previousSessionId: 'api:hinted-session',
          previousChannelType: 'api',
          source: 'test',
        },
      });
      const details = result.details as {
        previousSessionId: string | null;
        previousChannelType: string | null;
        newSessionId: string;
      };

      expect(details.previousSessionId).toBe('api:hinted-session');
      expect(details.previousChannelType).toBe('api');
      expect(details.newSessionId).toBe('api:session-test-02');
    } finally {
      await new Promise(resolve => setTimeout(resolve, 5));
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
