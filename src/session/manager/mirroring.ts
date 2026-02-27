import type { SubstrateConfig } from '../../types.js';
import type { SessionStore } from '../store.js';
import type { UserContinuityStore } from '../continuity.js';
import { evaluateMemoryPolicy, visibilitiesShareContinuity } from '../../trust/policy.js';
import type { ChannelVisibility, TrustLevel } from '../../trust/types.js';
import {
  DEFAULT_SESSION_MIRROR_ACTIVE_WINDOW_MS,
  DEFAULT_SESSION_MIRROR_MAX_CHARS,
  normalizeMirrorText,
  visibilityToMirrorSensitivity,
  type MirrorEntryMetadata,
} from '../manager-primitives.js';

export function isSessionMirroringGloballyEnabled(config: SubstrateConfig): boolean {
  return config.sessionMirrorEnabled !== false;
}

export function isSessionMirroringEnabledForChannel(config: SubstrateConfig, channelId: string): boolean {
  const overrides = config.sessionMirrorChannelOverrides;
  if (!overrides) return true;

  const exact = overrides[channelId];
  if (typeof exact === 'boolean') return exact;

  const separatorIdx = channelId.indexOf(':');
  if (separatorIdx > 0) {
    const prefix = channelId.slice(0, separatorIdx);
    const prefixMatch = overrides[prefix];
    if (typeof prefixMatch === 'boolean') return prefixMatch;
  } else if (/^\d{6,}$/.test(channelId)) {
    const discordMatch = overrides.discord;
    if (typeof discordMatch === 'boolean') return discordMatch;
  }

  for (const [pattern, value] of Object.entries(overrides)) {
    if (!pattern.endsWith('*')) continue;
    const candidatePrefix = pattern.slice(0, -1);
    if (candidatePrefix.length === 0) continue;
    if (channelId.startsWith(candidatePrefix)) return value;
  }

  return true;
}

export function mirrorMessageToActiveSessions(params: {
  config: SubstrateConfig;
  store: SessionStore;
  continuityStore: UserContinuityStore | null;
  continuityKey?: string;
  sourceChannelId: string;
  sourceVisibility: ChannelVisibility;
  sourceRole: 'user' | 'assistant';
  sourceAuthorName?: string;
  content: string;
  trustLevel: TrustLevel;
  timestamp: number;
  mirrorEnabled: boolean;
}): void {
  if (!params.mirrorEnabled) return;
  if (!params.continuityStore || !params.continuityKey) return;
  if (!isSessionMirroringEnabledForChannel(params.config, params.sourceChannelId)) return;
  if (!isSessionMirroringGloballyEnabled(params.config)) return;

  const maxChars = Math.max(32, params.config.sessionMirrorMaxChars ?? DEFAULT_SESSION_MIRROR_MAX_CHARS);
  const normalized = normalizeMirrorText(params.content, maxChars);
  if (!normalized.text) return;

  const activeWindowMs = Math.max(
    1_000,
    params.config.sessionMirrorActiveWindowMs ?? DEFAULT_SESSION_MIRROR_ACTIVE_WINDOW_MS,
  );
  const targets = params.continuityStore.getActiveChannels(params.continuityKey, {
    excludeChannelId: params.sourceChannelId,
    withinMs: activeWindowMs,
    nowMs: params.timestamp,
  });
  if (targets.length === 0) return;

  const sourceSensitivity = visibilityToMirrorSensitivity(params.sourceVisibility);
  const sourceSpeaker = params.sourceRole === 'assistant'
    ? 'PSFN'
    : (params.sourceAuthorName ?? 'User');

  for (const target of targets) {
    if (!isSessionMirroringEnabledForChannel(params.config, target.channelId)) continue;
    if (!visibilitiesShareContinuity(params.sourceVisibility, target.channelVisibility)) continue;

    const policy = evaluateMemoryPolicy({
      trustLevel: params.trustLevel,
      channelVisibility: target.channelVisibility,
      memorySensitivity: sourceSensitivity,
    });
    if (policy.decision !== 'allow') continue;

    const mirrorMetadata: MirrorEntryMetadata = {
      type: 'mirror',
      sourceChannelId: params.sourceChannelId,
      sourceRole: params.sourceRole,
      sourceAuthorName: params.sourceRole === 'user' ? sourceSpeaker : undefined,
      sourceVisibility: params.sourceVisibility,
      trustLevel: params.trustLevel,
      mirroredAt: params.timestamp,
      truncated: normalized.truncated,
    };

    params.store.append({
      channelId: target.channelId,
      role: 'system',
      content: `${sourceSpeaker} [from ${params.sourceChannelId}]: ${normalized.text}`,
      authorId: 'session-mirror',
      authorName: 'Session Mirror',
      timestamp: params.timestamp,
      metadata: JSON.stringify(mirrorMetadata),
      originChannelId: params.sourceChannelId,
      channelVisibility: target.channelVisibility,
    });
  }
}
