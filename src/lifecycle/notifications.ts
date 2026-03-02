// ── Lifecycle Notifications ──
// Sends Discord messages on pre-restart, ready, and shutdown events.
// Uses the configured heartbeat channel or last-active channel.

import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createComponentLogger } from '../logger.js';
import { inferSessionChannelType, isInternalSessionId } from '../session/session-id.js';

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

// ── Last-active session tracking ──

const LAST_ACTIVE_FILE = 'last_active_channel.json';

export interface LastActiveSessionData {
  sessionId: string;
  channelId: string;
  channelType?: string;
  timestamp: number;
}

export interface LastActiveSessionWriteInput {
  sessionId: string;
  channelType?: string;
  timestamp?: number;
}

export interface LatestSessionCandidate {
  sessionId: string;
  timestamp: number;
  channelType?: string;
}

export interface ResolveLatestSessionOptions {
  dataDir: string;
  computedLatestSession: LatestSessionCandidate | null;
  isSessionValid?: (sessionId: string) => boolean;
}

export interface LastActiveData {
  channelId: string;
  timestamp: number;
}

interface PendingLastActiveWrite {
  latest: LastActiveSessionData;
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

function normalizeLastActiveData(data: LastActiveData | LastActiveSessionData): LastActiveSessionData | null {
  const rawSessionId = (
    'sessionId' in data && typeof data.sessionId === 'string'
      ? data.sessionId
      : (typeof data.channelId === 'string' ? data.channelId : '')
  ).trim();
  if (!rawSessionId) return null;

  const timestamp = Number.isFinite(data.timestamp) ? data.timestamp : 0;
  const channelType = (
    'channelType' in data && typeof data.channelType === 'string' && data.channelType.trim().length > 0
  ) ? data.channelType.trim().toLowerCase() : inferSessionChannelType(rawSessionId);

  return {
    sessionId: rawSessionId,
    channelId: rawSessionId,
    channelType,
    timestamp,
  };
}

function toLastActiveSessionData(input: LastActiveSessionWriteInput): LastActiveSessionData | null {
  const sessionId = input.sessionId.trim();
  if (!sessionId || isInternalSessionId(sessionId)) return null;

  const timestamp = Number.isFinite(input.timestamp) && (input.timestamp ?? 0) > 0
    ? (input.timestamp as number)
    : Date.now();
  const normalizedType = typeof input.channelType === 'string' && input.channelType.trim().length > 0
    ? input.channelType.trim().toLowerCase()
    : inferSessionChannelType(sessionId);

  return {
    sessionId,
    channelId: sessionId,
    channelType: normalizedType,
    timestamp,
  };
}

function isPersistedLatestSessionValid(options: {
  persisted: LastActiveSessionData;
  computed: LastActiveSessionData | null;
  isSessionValid: (sessionId: string) => boolean;
}): boolean {
  if (!options.isSessionValid(options.persisted.sessionId)) return false;
  if (!Number.isFinite(options.persisted.timestamp) || options.persisted.timestamp <= 0) return false;
  if (!options.computed) return true;
  if (options.persisted.sessionId === options.computed.sessionId) return true;
  return options.persisted.timestamp >= options.computed.timestamp;
}

function normalizeComputedLatestSession(
  computedLatestSession: LatestSessionCandidate | null,
): LastActiveSessionData | null {
  if (!computedLatestSession) return null;
  return toLastActiveSessionData({
    sessionId: computedLatestSession.sessionId,
    channelType: computedLatestSession.channelType,
    timestamp: computedLatestSession.timestamp,
  });
}

export function readLastActiveSession(dataDir: string): LastActiveSessionData | null {
  const path = join(dataDir, LAST_ACTIVE_FILE);
  const pending = pendingLastActiveWrites.get(path);
  if (pending?.latest.sessionId) {
    return { ...pending.latest };
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as LastActiveData | LastActiveSessionData;
    return normalizeLastActiveData(data);
  } catch {
    return null;
  }
}

export function writeLastActiveSession(dataDir: string, input: LastActiveSessionWriteInput): void {
  const latest = toLastActiveSessionData(input);
  if (!latest) return;
  const path = join(dataDir, LAST_ACTIVE_FILE);

  const state = pendingLastActiveWrites.get(path) ?? {
    latest,
    dirty: false,
    writing: false,
  };
  state.latest = latest;
  state.dirty = true;
  pendingLastActiveWrites.set(path, state);

  if (!state.writing) {
    state.writing = true;
    void flushLastActiveWrite(path, state);
  }
}

export function resolveLastActiveSession(options: ResolveLatestSessionOptions): LastActiveSessionData | null {
  const isSessionValid = options.isSessionValid ?? (() => true);
  const persisted = readLastActiveSession(options.dataDir);
  const computed = normalizeComputedLatestSession(options.computedLatestSession);

  if (persisted && isPersistedLatestSessionValid({
    persisted,
    computed,
    isSessionValid,
  })) {
    return persisted;
  }

  if (computed && isSessionValid(computed.sessionId)) {
    return computed;
  }

  return null;
}

export function restoreLastActiveSession(options: ResolveLatestSessionOptions): LastActiveSessionData | null {
  const resolved = resolveLastActiveSession(options);
  if (!resolved) return null;

  writeLastActiveSession(options.dataDir, resolved);
  return resolved;
}

export function readLastActiveChannel(dataDir: string): string | null {
  return readLastActiveSession(dataDir)?.sessionId ?? null;
}

export function writeLastActiveChannel(dataDir: string, channelId: string): void {
  writeLastActiveSession(dataDir, {
    sessionId: channelId,
    channelType: inferSessionChannelType(channelId),
    timestamp: Date.now(),
  });
}

function resolveDiscordNotificationChannel(session: LastActiveSessionData | null): string | null {
  if (!session?.sessionId) return null;

  const normalizedSessionId = session.sessionId.trim();
  if (!normalizedSessionId) return null;

  if (session.channelType === 'discord') {
    if (normalizedSessionId.startsWith('discord:')) {
      const rawChannelId = normalizedSessionId.slice('discord:'.length).trim();
      return rawChannelId.length > 0 ? rawChannelId : null;
    }
    return normalizedSessionId;
  }

  if (session.channelType && session.channelType !== 'discord') {
    return null;
  }

  if (normalizedSessionId.startsWith('discord:')) {
    const rawChannelId = normalizedSessionId.slice('discord:'.length).trim();
    return rawChannelId.length > 0 ? rawChannelId : null;
  }

  // Backward-compatible fallback for legacy payloads that did not include channelType.
  return normalizedSessionId;
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
    // Prefer the latest known Discord session, fall back to heartbeat channel.
    const lastActive = readLastActiveSession(this.dataDir);
    const sessionChannel = resolveDiscordNotificationChannel(lastActive);
    return sessionChannel ?? this.heartbeatChannelId ?? null;
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
