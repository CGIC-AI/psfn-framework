import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveLastActiveSessionPath } from '../../persistence/layout.js';
import {
  DiscordLifecycleNotifier,
  readLastActiveSession,
  resolveLastActiveSession,
  restoreLastActiveSession,
  readLastActiveChannel,
  writeLastActiveSession,
  writeLastActiveChannel,
} from './notifications.js';
import type { MessageSender } from './notifications.js';

async function waitForFile(path: string, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for file: ${path}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('DiscordLifecycleNotifier', () => {
  let tempDir: string;
  let mockSender: MessageSender;
  let sentMessages: Array<{ channelId: string; content: string }>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
    sentMessages = [];
    mockSender = {
      send: vi.fn(async (channelId: string, content: string) => {
        sentMessages.push({ channelId, content });
      }),
    };
  });

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 25));
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('notifyPreRestart', () => {
    it('sends message to heartbeat channel', async () => {
      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
      });

      await notifier.notifyPreRestart();

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].channelId).toBe('hb-channel');
      expect(sentMessages[0].content).toContain('brb');
    });

    it('includes reason when provided', async () => {
      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
      });

      await notifier.notifyPreRestart('updating config');

      expect(sentMessages[0].content).toContain('updating config');
    });

    it('prefers configured heartbeat channel over last-active channel', async () => {
      writeLastActiveChannel(tempDir, '1234567890123456');

      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
      });

      await notifier.notifyPreRestart();

      expect(sentMessages[0].channelId).toBe('hb-channel');
    });

    it('recovers a raw discord channel id from older compound session ids', async () => {
      writeLastActiveSession(tempDir, {
        sessionId: '1313001762793197678#20260318_1313001762793197678_388908766306893854_277462',
        channelType: 'discord',
        timestamp: Date.now(),
      });

      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        dataDir: tempDir,
        startTime: Date.now(),
      });

      await notifier.notifyReady();

      expect(sentMessages[0].channelId).toBe('1313001762793197678');
      expect(sentMessages[0].content).toContain("I'm back");
    });

    it('falls back to heartbeat when latest active session is non-discord', async () => {
      writeLastActiveSession(tempDir, {
        sessionId: 'api:admin-user',
        channelType: 'api',
        timestamp: Date.now(),
      });

      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
      });

      await notifier.notifyPreRestart();

      expect(sentMessages[0].channelId).toBe('hb-channel');
    });

    it('falls back to the latest active discord session when no heartbeat channel is configured', async () => {
      writeLastActiveSession(tempDir, {
        sessionId: '1313001762793197678#20260318_1313001762793197678_388908766306893854_277462',
        channelType: 'discord',
        timestamp: Date.now(),
      });

      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        dataDir: tempDir,
        startTime: Date.now(),
      });

      await notifier.notifyReady();

      expect(sentMessages[0].channelId).toBe('1313001762793197678');
    });

    it('does not throw when sender fails', async () => {
      const failSender: MessageSender = {
        send: vi.fn(async () => { throw new Error('send failed'); }),
      };

      const notifier = new DiscordLifecycleNotifier({
        sender: failSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
      });

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await notifier.notifyPreRestart(); // should not throw
      spy.mockRestore();
    });

    it('does nothing when no channel is configured', async () => {
      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        dataDir: tempDir,
        startTime: Date.now(),
      });

      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await notifier.notifyPreRestart();
      spy.mockRestore();

      expect(sentMessages).toHaveLength(0);
    });
  });

  describe('notifyReady', () => {
    it('sends ready message with startup time', async () => {
      const startTime = Date.now() - 5000; // 5 seconds ago

      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime,
      });

      await notifier.notifyReady();

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].content).toContain("I'm back");
      expect(sentMessages[0].content).toMatch(/\d+s/);
    });
  });

  describe('notifyShutdown', () => {
    it('sends shutdown message', async () => {
      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
      });

      await notifier.notifyShutdown();

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].content).toContain('Going offline');
    });

    it('includes reason when provided', async () => {
      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
      });

      await notifier.notifyShutdown('maintenance');

      expect(sentMessages[0].content).toContain('maintenance');
    });
  });
});

describe('Last-active channel tracking', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lastactive-test-'));
  });

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 25));
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes and reads last active channel', () => {
    writeLastActiveChannel(tempDir, 'test-channel-123');
    const result = readLastActiveChannel(tempDir);
    expect(result).toBe('test-channel-123');
  });

  it('overwrites previous value', () => {
    writeLastActiveChannel(tempDir, 'first-channel');
    writeLastActiveChannel(tempDir, 'second-channel');
    const result = readLastActiveChannel(tempDir);
    expect(result).toBe('second-channel');
  });

  it('returns null when no file exists', () => {
    const result = readLastActiveChannel(tempDir);
    expect(result).toBeNull();
  });

  it('skips internal channels', () => {
    writeLastActiveChannel(tempDir, 'real-channel');
    writeLastActiveChannel(tempDir, 'internal:heartbeat');
    const result = readLastActiveChannel(tempDir);
    expect(result).toBe('real-channel');
  });

  it('skips shard channels', () => {
    writeLastActiveChannel(tempDir, 'real-channel');
    writeLastActiveChannel(tempDir, 'shard:abc-123');
    const result = readLastActiveChannel(tempDir);
    expect(result).toBe('real-channel');
  });

  it('stores timestamp with channel', async () => {
    writeLastActiveChannel(tempDir, 'timestamped-channel');
    const lastActivePath = resolveLastActiveSessionPath(tempDir);
    await waitForFile(lastActivePath);
    const raw = readFileSync(lastActivePath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.timestamp).toBeGreaterThan(0);
    expect(data.channelId).toBe('timestamped-channel');
  });

  it('reads and writes last-active session metadata', () => {
    writeLastActiveSession(tempDir, {
      sessionId: '123456789012345678',
      channelId: '123456789012345678',
      channelType: 'discord',
      timestamp: 1234,
    });
    const session = readLastActiveSession(tempDir);
    expect(session).toEqual({
      sessionId: '123456789012345678',
      channelId: '123456789012345678',
      channelType: 'discord',
      timestamp: 1234,
    });
  });

  it('throws when persisted last-active session state is malformed', () => {
    const lastActivePath = resolveLastActiveSessionPath(tempDir);
    mkdirSync(dirname(lastActivePath), { recursive: true });
    writeFileSync(lastActivePath, '{"channelId":', 'utf-8');

    expect(() => readLastActiveSession(tempDir)).toThrow(
      new RegExp('Failed to read last-active session state'),
    );
  });

  it('preserves transport channel id separately from session id when provided', () => {
    writeLastActiveSession(tempDir, {
      sessionId: '1313001762793197678#20260318_1313001762793197678_388908766306893854_277462',
      channelId: '1313001762793197678',
      channelType: 'discord',
      timestamp: 1234,
    });

    const session = readLastActiveSession(tempDir);
    expect(session).toEqual({
      sessionId: '1313001762793197678#20260318_1313001762793197678_388908766306893854_277462',
      channelId: '1313001762793197678',
      channelType: 'discord',
      timestamp: 1234,
    });
  });

  it('prefers persisted latest session when valid and newer than computed latest', () => {
    writeLastActiveSession(tempDir, {
      sessionId: 'api:persisted',
      channelType: 'api',
      timestamp: 3000,
    });

    const resolved = resolveLastActiveSession({
      dataDir: tempDir,
      computedLatestSession: {
        sessionId: 'api:computed',
        channelType: 'api',
        timestamp: 2000,
      },
      isSessionValid: () => true,
    });

    expect(resolved?.sessionId).toBe('api:persisted');
  });

  it('falls back to computed latest session when persisted metadata is stale', () => {
    writeLastActiveSession(tempDir, {
      sessionId: 'api:stale',
      channelType: 'api',
      timestamp: 1000,
    });

    const resolved = restoreLastActiveSession({
      dataDir: tempDir,
      computedLatestSession: {
        sessionId: 'api:latest',
        channelType: 'api',
        timestamp: 2000,
      },
      isSessionValid: () => true,
    });

    expect(resolved?.sessionId).toBe('api:latest');
    expect(readLastActiveSession(tempDir)?.sessionId).toBe('api:latest');
  });
});
