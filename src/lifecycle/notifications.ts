// ── Lifecycle Notifications ──
// Sends Discord messages on pre-restart, ready, and shutdown events.
// Uses the configured heartbeat channel or last-active channel.

import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('Lifecycle');

// ── Interfaces ──

/** Minimal send capability — satisfied by DiscordAdapter and GatewayClient */
export interface MessageSender {
  send(channelId: string, content: string): Promise<void>;
}

export interface LifecycleNotifier {
  notifyPreRestart(reason?: string): Promise<void>;
  notifyReady(): Promise<void>;
  notifyShutdown(reason?: string): Promise<void>;
}

export interface LifecycleNotifierConfig {
  sender: MessageSender;
  heartbeatChannelId?: string;
  dataDir: string;
  startTime: number;
}

// ── Last-active channel tracking ──

const LAST_ACTIVE_FILE = 'last_active_channel.json';

export interface LastActiveData {
  channelId: string;
  timestamp: number;
}

interface PendingLastActiveWrite {
  latest: LastActiveData;
  dirty: boolean;
  writing: boolean;
}

const pendingLastActiveWrites = new Map<string, PendingLastActiveWrite>();

async function flushLastActiveWrite(path: string, state: PendingLastActiveWrite): Promise<void> {
  while (state.dirty) {
    state.dirty = false;
    const snapshot = state.latest;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(snapshot) + '\n', 'utf-8');
    } catch (err) {
      log.error('Failed to write last active channel', { error: String(err) });
    }
  }

  state.writing = false;
  if (!state.dirty) {
    pendingLastActiveWrites.delete(path);
    return;
  }

  state.writing = true;
  void flushLastActiveWrite(path, state);
}

export function readLastActiveChannel(dataDir: string): string | null {
  const path = join(dataDir, LAST_ACTIVE_FILE);
  const pending = pendingLastActiveWrites.get(path);
  if (pending?.latest.channelId) {
    return pending.latest.channelId;
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as LastActiveData;
    if (typeof data.channelId === 'string' && data.channelId.length > 0) {
      return data.channelId;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeLastActiveChannel(dataDir: string, channelId: string): void {
  // Skip internal channels (heartbeat, shards, etc.)
  if (channelId.startsWith('internal:') || channelId.startsWith('shard:')) {
    return;
  }
  const path = join(dataDir, LAST_ACTIVE_FILE);

  const state = pendingLastActiveWrites.get(path) ?? {
    latest: { channelId, timestamp: Date.now() },
    dirty: false,
    writing: false,
  };
  state.latest = { channelId, timestamp: Date.now() };
  state.dirty = true;
  pendingLastActiveWrites.set(path, state);

  if (!state.writing) {
    state.writing = true;
    void flushLastActiveWrite(path, state);
  }
}

// ── Notifier implementation ──

export class DiscordLifecycleNotifier implements LifecycleNotifier {
  private sender: MessageSender;
  private heartbeatChannelId: string | undefined;
  private dataDir: string;
  private startTime: number;

  constructor(config: LifecycleNotifierConfig) {
    this.sender = config.sender;
    this.heartbeatChannelId = config.heartbeatChannelId;
    this.dataDir = config.dataDir;
    this.startTime = config.startTime;
  }

  /** Resolve which channel to send lifecycle messages to */
  private getNotificationChannel(): string | null {
    // Prefer last active channel, fall back to heartbeat channel
    const lastActive = readLastActiveChannel(this.dataDir);
    return lastActive ?? this.heartbeatChannelId ?? null;
  }

  async notifyPreRestart(reason?: string): Promise<void> {
    const channelId = this.getNotificationChannel();
    if (!channelId) {
      log.warn('No notification channel configured, skipping pre-restart notification');
      return;
    }

    const msg = reason
      ? `Gonna reboot real quick -- ${reason}. brb~`
      : 'Gonna reboot real quick, brb~';

    try {
      await this.sender.send(channelId, msg);
      log.info(`Pre-restart notification sent to ${channelId}`);
    } catch (err) {
      log.error('Failed to send pre-restart notification', { error: String(err) });
      // Don't throw — we still want to restart even if notification fails
    }
  }

  async notifyReady(): Promise<void> {
    const channelId = this.getNotificationChannel();
    if (!channelId) {
      log.warn('No notification channel configured, skipping ready notification');
      return;
    }

    const uptimeMs = Date.now() - this.startTime;
    const uptimeSec = Math.round(uptimeMs / 1000);
    const msg = `I'm back~ (startup took ${uptimeSec}s)`;

    try {
      await this.sender.send(channelId, msg);
      log.info(`Ready notification sent to ${channelId}`);
    } catch (err) {
      log.error('Failed to send ready notification', { error: String(err) });
    }
  }

  async notifyShutdown(reason?: string): Promise<void> {
    const channelId = this.getNotificationChannel();
    if (!channelId) {
      log.warn('No notification channel configured, skipping shutdown notification');
      return;
    }

    const msg = reason
      ? `Going offline -- ${reason}. See you soon.`
      : 'Going offline for a bit. See you soon.';

    try {
      await this.sender.send(channelId, msg);
      log.info(`Shutdown notification sent to ${channelId}`);
    } catch (err) {
      log.error('Failed to send shutdown notification', { error: String(err) });
    }
  }
}
