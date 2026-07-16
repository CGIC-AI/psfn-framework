import type { ProviderMembershipObservation } from './discord-evidence-runtime.js';

export type DiscordEvidenceReauthenticationReason =
  | 'evidence_expired'
  | 'provider_evidence_unavailable'
  | 'provider_evidence_invalid'
  | 'session_expired';

export interface ActiveDiscordMembershipEvidence {
  principalId: string;
  providerSubjectId: string;
  lifecycleId: string;
  generation: number;
  providerMembershipEvidence: {
    status: 'observed';
    providerSubjectId: string;
    observedAt: string;
    guilds: Array<{ guildId: string; roleIds: string[] }>;
  };
  providerExpiresAt: Date;
  sessionExpiresAt: Date;
  renewalAttempted: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export function discordEvidenceLifecycleKey(
  principalId: string,
  providerSubjectId: string,
): string {
  return `${principalId}\u0000${providerSubjectId}`;
}

export function boundDiscordMembershipEvidence(
  providerSubjectId: string,
  observation: ProviderMembershipObservation,
): ActiveDiscordMembershipEvidence['providerMembershipEvidence'] {
  return {
    status: 'observed',
    providerSubjectId,
    observedAt: observation.observedAt.toISOString(),
    guilds: observation.guilds.map(guild => ({
      guildId: guild.guildId,
      roleIds: [...guild.roleIds],
    })),
  };
}

export function retireActiveDiscordEvidence(
  active: Map<string, ActiveDiscordMembershipEvidence>,
  reauthentication: Map<string, DiscordEvidenceReauthenticationReason>,
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void,
  entry: ActiveDiscordMembershipEvidence,
): boolean {
  const key = discordEvidenceLifecycleKey(entry.principalId, entry.providerSubjectId);
  if (active.get(key) !== entry) return false;
  if (entry.timer) clearTimer(entry.timer);
  active.delete(key);
  reauthentication.delete(key);
  return true;
}

export function retireAllActiveDiscordEvidence(
  active: Map<string, ActiveDiscordMembershipEvidence>,
  reauthentication: Map<string, DiscordEvidenceReauthenticationReason>,
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void,
): void {
  clearActiveDiscordEvidenceTimers(active, clearTimer);
  active.clear();
  reauthentication.clear();
}

export function clearActiveDiscordEvidenceTimers(
  active: Map<string, ActiveDiscordMembershipEvidence>,
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void,
): void {
  for (const entry of active.values()) {
    if (entry.timer) clearTimer(entry.timer);
  }
}
