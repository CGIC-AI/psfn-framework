import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DiscordLifecycleNotifier,
  readLastActiveChannel,
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

    it('prefers last-active channel over heartbeat channel', async () => {
      writeLastActiveChannel(tempDir, 'active-channel');

      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
      });

      await notifier.notifyPreRestart();

      expect(sentMessages[0].channelId).toBe('active-channel');
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
    const lastActivePath = join(tempDir, 'last_active_channel.json');
    await waitForFile(lastActivePath);
    const raw = readFileSync(lastActivePath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.timestamp).toBeGreaterThan(0);
    expect(data.channelId).toBe('timestamped-channel');
  });
});
