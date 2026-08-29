import type {
  ClaimedConversationalActivityWorkItem,
  ConversationalActivityWorksetPort,
} from '../../core/session/conversational-activity-workset.js';

export const SLEEPTIME_WORKSET_STAGES = [
  'sleep_consolidation',
  'arc_formation',
  'dream_meaning',
  'wiki_pass',
  'orientation_review',
] as const;

export type SleeptimeWorksetStage = (typeof SLEEPTIME_WORKSET_STAGES)[number];

export interface SleeptimeWorksetStageInput {
  logicalSessionId: string;
  revision: number;
  stage: SleeptimeWorksetStage;
}

export interface SleeptimeWorksetFailure {
  logicalSessionId: string;
  revision: number;
  stage: SleeptimeWorksetStage;
  message: string;
}

export type SleeptimeWorksetRunOutcome =
  | {
    outcome: 'complete';
    completedSessions: number;
    remainingSessions: 0;
  }
  | {
    outcome: 'yield';
    completedSessions: number;
    remainingSessions: number;
  }
  | {
    outcome: 'retry';
    completedSessions: number;
    remainingSessions: number;
    failures: SleeptimeWorksetFailure[];
  };

export interface SleeptimeWorksetRunnerOptions {
  workset: ConversationalActivityWorksetPort;
  claimantId: string;
  runStage(input: SleeptimeWorksetStageInput): Promise<void>;
  shouldYield?: () => boolean | Promise<boolean>;
}

function requireClaimantId(value: string): string {
  const claimantId = value.trim();
  if (!claimantId) throw new Error('Sleeptime workset claimantId must be non-empty');
  return claimantId;
}

function isSleeptimeStage(value: string): value is SleeptimeWorksetStage {
  return (SLEEPTIME_WORKSET_STAGES as readonly string[]).includes(value);
}

/**
 * Drains one stable snapshot of the companion's changed conversational sessions.
 * The durable port owns claims and checkpoints; this runner only advances one
 * ordered stage at a time, so a fresh process can safely resume the same claim.
 */
export class SleeptimeWorksetRunner {
  private readonly workset: ConversationalActivityWorksetPort;
  private readonly claimantId: string;
  private readonly runStage: SleeptimeWorksetRunnerOptions['runStage'];
  private readonly shouldYield: NonNullable<SleeptimeWorksetRunnerOptions['shouldYield']>;

  constructor(options: SleeptimeWorksetRunnerOptions) {
    this.workset = options.workset;
    this.claimantId = requireClaimantId(options.claimantId);
    this.runStage = options.runStage;
    this.shouldYield = options.shouldYield ?? (() => false);
  }

  async run(
    providedSnapshot?: readonly Awaited<ReturnType<ConversationalActivityWorksetPort['enumerate']>>[number][],
  ): Promise<SleeptimeWorksetRunOutcome> {
    const snapshot = [...(providedSnapshot
      ?? await this.workset.enumerate('sleeptime_consolidation'))]
      .sort((left, right) => left.logicalSessionId.localeCompare(right.logicalSessionId));
    let completedSessions = 0;
    const failures: SleeptimeWorksetFailure[] = [];

    for (const item of snapshot) {
      const claim = await this.resolveClaim(item);
      if (!claim) {
        failures.push({
          logicalSessionId: item.logicalSessionId,
          revision: item.revision,
          stage: 'sleep_consolidation',
          message: 'Sleeptime work item could not be claimed',
        });
        continue;
      }

      const completedStages = new Set(
        claim.completedStages.filter(isSleeptimeStage),
      );
      let sessionFailed = false;
      for (const stage of SLEEPTIME_WORKSET_STAGES) {
        if (completedStages.has(stage)) continue;
        if (await this.shouldYield()) {
          return {
            outcome: 'yield',
            completedSessions,
            remainingSessions: snapshot.length - completedSessions,
          };
        }
        try {
          await this.runStage({
            logicalSessionId: claim.logicalSessionId,
            revision: claim.revision,
            stage,
          });
          await this.workset.checkpointStage({
            purpose: claim.purpose,
            logicalSessionId: claim.logicalSessionId,
            revision: claim.revision,
            claimantId: this.claimantId,
            stage,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.workset.recordFailure({
            purpose: claim.purpose,
            logicalSessionId: claim.logicalSessionId,
            revision: claim.revision,
            claimantId: this.claimantId,
            stage,
            message,
          });
          failures.push({
            logicalSessionId: claim.logicalSessionId,
            revision: claim.revision,
            stage,
            message,
          });
          sessionFailed = true;
          break;
        }
      }

      if (sessionFailed) continue;
      await this.workset.checkpoint({
        purpose: claim.purpose,
        logicalSessionId: claim.logicalSessionId,
        revision: claim.revision,
        claimantId: this.claimantId,
      });
      completedSessions += 1;
    }

    if (failures.length > 0) {
      return {
        outcome: 'retry',
        completedSessions,
        remainingSessions: snapshot.length - completedSessions,
        failures,
      };
    }
    return { outcome: 'complete', completedSessions, remainingSessions: 0 };
  }

  private async resolveClaim(
    item: Awaited<ReturnType<ConversationalActivityWorksetPort['enumerate']>>[number],
  ): Promise<ClaimedConversationalActivityWorkItem | null> {
    if (item.claimantId === this.claimantId) {
      return this.workset.resumeClaim({
        purpose: item.purpose,
        logicalSessionId: item.logicalSessionId,
        claimantId: this.claimantId,
      });
    }
    if (item.claimantId) return null;
    return this.workset.claim({
      purpose: item.purpose,
      logicalSessionId: item.logicalSessionId,
      revision: item.revision,
      claimantId: this.claimantId,
    });
  }
}
