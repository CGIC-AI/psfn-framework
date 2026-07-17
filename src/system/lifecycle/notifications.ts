// ── Lifecycle Notifications ──
// Sends Discord messages on pre-restart, ready, and shutdown events.
// Uses the configured heartbeat channel or last-active channel.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import {
  resolveLastActiveSessionPath,
  resolveReadyNotificationMarkerPath,
} from '../../persistence/layout.js';
import { inferSessionChannelType, isInternalSessionId } from '../../core/session/session-id.js';

const log = createComponentLogger('Lifecycle');
const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/;

// Suppress duplicate "I'm back" announcements when a deploy boots the agent 2-3 times
// (initial start + restart(s) on gateway RPC loss) for the same image tag + channel.
const READY_NOTIFICATION_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

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
  /** Deploy image tag used to dedupe ready notifications across boot restarts. Falls back to PSFN_IMAGE_TAG. */
  imageTag?: string;
}

// ── Last-active session tracking ──

export interface LastActiveSessionData {
  sessionId: string;
  channelId: string;
  channelType?: string;
  timestamp: number;
}

export interface LastActiveSessionWriteInput {
  sessionId: string;
  channelId?: string;
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

function isMissingLastActiveSessionFile(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

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
  pendingLastActiveWrites.delete(path);
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
  const rawChannelId = typeof input.channelId === 'string' ? input.channelId.trim() : '';

  const timestamp = Number.isFinite(input.timestamp) && (input.timestamp ?? 0) > 0
    ? (input.timestamp as number)
    : Date.now();
  const normalizedType = typeof input.channelType === 'string' && input.channelType.trim().length > 0
    ? input.channelType.trim().toLowerCase()
    : inferSessionChannelType(sessionId);

  return {
    sessionId,
    channelId: rawChannelId || sessionId,
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
  const path = resolveLastActiveSessionPath(dataDir);
  const pending = pendingLastActiveWrites.get(path);
  if (pending?.latest.sessionId) {
    return { ...pending.latest };
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as LastActiveData | LastActiveSessionData;
    return normalizeLastActiveData(data);
  } catch (error) {
    if (isMissingLastActiveSessionFile(error)) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error('Failed to read last-active session state from ' + path + ': ' + message);
  }
}

export function writeLastActiveSession(dataDir: string, input: LastActiveSessionWriteInput): void {
  const latest = toLastActiveSessionData(input);
  if (!latest) return;
  const path = resolveLastActiveSessionPath(dataDir);

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
  if (!session) return null;

  const normalizeDiscordChannelCandidate = (rawValue: string): string | null => {
    const normalized = rawValue.trim();
    if (!normalized) return null;
    if (DISCORD_CHANNEL_ID_PATTERN.test(normalized)) return normalized;
    if (normalized.startsWith('discord:')) {
      const rawChannelId = normalized.slice('discord:'.length).trim();
      return DISCORD_CHANNEL_ID_PATTERN.test(rawChannelId) ? rawChannelId : null;
    }
    const compoundSeparator = normalized.indexOf('#');
    if (compoundSeparator > 0) {
      const rawChannelId = normalized.slice(0, compoundSeparator).trim();
      return DISCORD_CHANNEL_ID_PATTERN.test(rawChannelId) ? rawChannelId : null;
    }
    return null;
  };

  const channelCandidates = [
    session.channelId,
    session.sessionId,
  ];

  if (session.channelType === 'discord') {
    for (const candidate of channelCandidates) {
      const resolved = normalizeDiscordChannelCandidate(candidate);
      if (resolved) return resolved;
    }
    return null;
  }

  if (session.channelType && session.channelType !== 'discord') {
    return null;
  }

  for (const candidate of channelCandidates) {
    const resolved = normalizeDiscordChannelCandidate(candidate);
    if (resolved) return resolved;
  }

  return null;
}

// ── Ready-notification dedupe marker ──

interface ReadyNotificationMarker {
  imageTag: string;
  channelId: string;
  timestamp: number;
}

function readReadyNotificationMarker(dataDir: string): ReadyNotificationMarker | null {
  const path = resolveReadyNotificationMarkerPath(dataDir);
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ReadyNotificationMarker>;
    if (
      typeof data.imageTag === 'string'
      && typeof data.channelId === 'string'
      && typeof data.timestamp === 'number'
      && Number.isFinite(data.timestamp)
    ) {
      return { imageTag: data.imageTag, channelId: data.channelId, timestamp: data.timestamp };
    }
    return null;
  } catch (error) {
    if (isMissingLastActiveSessionFile(error)) return null;
    // Fail closed for dedupe: an unreadable marker must not silence the announcement.
    log.warn('Failed to read ready-notification marker; will announce', { error: String(error) });
    return null;
  }
}

function writeReadyNotificationMarker(dataDir: string, marker: ReadyNotificationMarker): void {
  const path = resolveReadyNotificationMarkerPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(marker) + '\n', 'utf-8');
  } catch (error) {
    log.error('Failed to persist ready-notification marker', { error: String(error) });
  }
}

// ── Notifier implementation ──

export class DiscordLifecycleNotifier implements LifecycleNotifier {
  private sender: MessageSender;
  private heartbeatChannelId: string | undefined;
  private dataDir: string;
  private startTime: number;
  private imageTag: string | undefined;

  constructor(config: LifecycleNotifierConfig) {
    this.sender = config.sender;
    this.heartbeatChannelId = config.heartbeatChannelId;
    this.dataDir = config.dataDir;
    this.startTime = config.startTime;
    this.imageTag = config.imageTag?.trim() || process.env.PSFN_IMAGE_TAG?.trim() || undefined;
  }

  /** Resolve which channel to send lifecycle messages to */
  private getNotificationChannel(): string | null {
    // Prefer the configured Discord broadcast/heartbeat channel.
    // Fall back to the latest active Discord session when no broadcast channel is configured.
    if (this.heartbeatChannelId?.trim()) {
      return this.heartbeatChannelId.trim();
    }
    const lastActive = readLastActiveSession(this.dataDir);
    const sessionChannel = resolveDiscordNotificationChannel(lastActive);
    return sessionChannel ?? null;
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

    if (this.shouldSuppressReadyNotification(channelId)) {
      log.info(
        `Ready notification suppressed for ${channelId} `
          + `(duplicate boot of image ${this.imageTag} within dedupe window)`,
      );
      return;
    }

    const uptimeMs = Date.now() - this.startTime;
    const uptimeSec = Math.round(uptimeMs / 1000);
    const msg = `I'm back~ (startup took ${uptimeSec}s)`;

    try {
      await this.sender.send(channelId, msg);
      log.info(`Ready notification sent to ${channelId}`);
      this.recordReadyNotification(channelId);
    } catch (err) {
      log.error('Failed to send ready notification', { error: String(err) });
    }
  }

  /**
   * Suppress a repeat "I'm back" only when a prior boot of the *same* image tag
   * already announced to this channel inside the dedupe window. A new build, a
   * different channel, an expired marker, or a missing image tag all announce.
   */
  private shouldSuppressReadyNotification(channelId: string): boolean {
    if (!this.imageTag) return false;
    const marker = readReadyNotificationMarker(this.dataDir);
    if (!marker) return false;
    if (marker.imageTag !== this.imageTag) return false;
    if (marker.channelId !== channelId) return false;
    const age = Date.now() - marker.timestamp;
    if (!Number.isFinite(age) || age < 0) return false;
    return age < READY_NOTIFICATION_DEDUPE_WINDOW_MS;
  }

  private recordReadyNotification(channelId: string): void {
    if (!this.imageTag) return;
    writeReadyNotificationMarker(this.dataDir, {
      imageTag: this.imageTag,
      channelId,
      timestamp: Date.now(),
    });
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

export function createDiscordLifecycleNotifier(
  config: LifecycleNotifierConfig,
): LifecycleNotifier {
  return new DiscordLifecycleNotifier(config);
}
