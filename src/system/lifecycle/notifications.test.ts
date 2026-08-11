import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveLastActiveSessionPath } from '../../persistence/layout.js';
import {
  DiscordLifecycleNotifier,
  isCompanionReadyLifecycleNotification,
  readLastActiveSession,
  resolveLastActiveSession,
  restoreLastActiveSession,
  readLastActiveChannel,
  writeLastActiveSession,
  writeLastActiveChannel,
} from './notifications.js';
import type { MessageSender } from './notifications.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';

describe('companion ready lifecycle notification authentication', () => {
  const companionId = createCompanionId('22222222-2222-4222-8222-222222222222');

  it('matches only the exact ready message for the bound companion identity', () => {
    expect(isCompanionReadyLifecycleNotification(
      `[agent:${companionId}] Companion is back~ (startup took 0s)`,
      companionId,
    )).toBe(true);
    expect(isCompanionReadyLifecycleNotification(
      `[agent:${companionId}] Companion is back~ (startup took 17s)`,
      companionId,
    )).toBe(true);
    expect(isCompanionReadyLifecycleNotification(
      `[agent:${companionId}] I'm back~ (startup took 0s)`,
      companionId,
    )).toBe(true);
  });

  it.each([
    "[agent:22222222-2222-4222-8222-222222222223] Companion is back~ (startup took 0s)",
    "[agent:22222222-2222-4222-8222-222222222222] Companion is back~ (startup took 00s)",
    "[agent:22222222-2222-4222-8222-222222222222] Companion is back~ (startup took -1s)",
    "[agent:22222222-2222-4222-8222-222222222222] is back~ (startup took 0s)",
    "prefix [agent:22222222-2222-4222-8222-222222222222] Companion is back~ (startup took 0s)",
  ])('rejects unauthenticated or non-canonical lookalike %j', (content) => {
    expect(isCompanionReadyLifecycleNotification(content, companionId)).toBe(false);
  });
});

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
      expect(sentMessages[0].content).toContain('Unknown companion is restarting');
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
      expect(sentMessages[0].content).toContain('is back');
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
      expect(sentMessages[0].content).toContain('is back');
      expect(sentMessages[0].content).toMatch(/\d+s/);
      // Fail-closed process-role label when no subsystemLabel is configured.
      expect(sentMessages[0].content).toMatch(/^\[agent\] /);
    });

    it('prefixes the ready message with the configured subsystem label', async () => {
      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
        subsystemLabel: 'agent:companion',
        companionDisplayLabel: 'Companion',
      });

      await notifier.notifyReady();

      expect(sentMessages[0].content).toMatch(/^\[agent:companion\] Companion is back/);
    });

    it('falls back to the process role when the subsystem label is blank', async () => {
      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
        subsystemLabel: '   ',
      });

      await notifier.notifyReady();

      expect(sentMessages[0].content).toMatch(/^\[agent\] /);
    });

    // psfn-framework-dq9c: a deploy boots the agent 2-3 times; only the first should announce.
    it('suppresses a duplicate ready notification for the same image tag and channel', async () => {
      const config = {
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
        imageTag: '0.1.0-kube',
      };

      await new DiscordLifecycleNotifier(config).notifyReady();
      await new DiscordLifecycleNotifier(config).notifyReady();
      await new DiscordLifecycleNotifier(config).notifyReady();

      expect(sentMessages).toHaveLength(1);
    });

    it('announces again when the image tag changes (new build)', async () => {
      const base = {
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
      };

      await new DiscordLifecycleNotifier({ ...base, imageTag: '0.1.0-kube' }).notifyReady();
      await new DiscordLifecycleNotifier({ ...base, imageTag: '0.2.0-kube' }).notifyReady();

      expect(sentMessages).toHaveLength(2);
    });

    it('does not dedupe when no image tag is available', async () => {
      const prev = process.env.PSFN_IMAGE_TAG;
      delete process.env.PSFN_IMAGE_TAG;
      try {
        const config = {
          sender: mockSender,
          heartbeatChannelId: 'hb-channel',
          dataDir: tempDir,
          startTime: Date.now(),
        };

        await new DiscordLifecycleNotifier(config).notifyReady();
        await new DiscordLifecycleNotifier(config).notifyReady();

        expect(sentMessages).toHaveLength(2);
      } finally {
        if (prev === undefined) {
          delete process.env.PSFN_IMAGE_TAG;
        } else {
          process.env.PSFN_IMAGE_TAG = prev;
        }
      }
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
      expect(sentMessages[0].content).toContain('Unknown companion is going offline');
      expect(sentMessages[0].content).toMatch(/^\[agent\] /);
    });

    it('prefixes the shutdown message with the configured subsystem label', async () => {
      const notifier = new DiscordLifecycleNotifier({
        sender: mockSender,
        heartbeatChannelId: 'hb-channel',
        dataDir: tempDir,
        startTime: Date.now(),
        subsystemLabel: 'agent:companion',
        companionDisplayLabel: 'Companion',
      });

      await notifier.notifyShutdown('maintenance');

      expect(sentMessages[0].content).toMatch(
        /^\[agent:companion\] Companion is going offline -- maintenance\./,
      );
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
