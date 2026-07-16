import type {
  DiscordCompanionEvidenceObserverPort,
  DiscordEvidenceObservationPort,
} from './discord-evidence-types.js';

/**
 * Gateway-owned late-binding registry for per-companion bot observers. Fleet
 * auth persistence starts before channel adapters; an unregistered or stopped
 * companion therefore produces an explicit bot-absent denial, never a cache
 * fallback or a different companion's observation.
 */
export class DiscordEvidenceObserverRegistry implements DiscordEvidenceObservationPort {
  private readonly observers = new Map<string, DiscordCompanionEvidenceObserverPort>();

  register(companionId: string, observer: DiscordCompanionEvidenceObserverPort): void {
    if (this.observers.has(companionId)) {
      throw new Error(`Duplicate Discord evidence observer for companion ${companionId}`);
    }
    this.observers.set(companionId, observer);
  }

  async observe(
    input: Parameters<DiscordEvidenceObservationPort['observe']>[0],
  ): Promise<unknown> {
    const observer = this.observers.get(input.companionId);
    if (!observer) return { status: 'bot_absent' };
    return await observer.observeDiscordEvidence({
      providerSubjectId: input.providerSubjectId,
      targets: input.targets,
    });
  }
}
