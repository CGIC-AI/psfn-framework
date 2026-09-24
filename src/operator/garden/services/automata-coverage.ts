import { AUTOMATA_CLASS_GOVERNED_ADAPTERS } from '../../../faculties/automata/bus/class-adapters.js';
import type {
  AutomataBusHealthOwnerPolicy,
  AutomataRunOutcome,
  AutomataRunRecord,
  EffectiveAutomataClassDescriptor,
} from '../../../faculties/automata/registry-contract.js';

/** Aggregate Bus learning activity for one class inside the owner window. */
export interface AdminAutomataClassActivity {
  automatonClass: string;
  usefulHandoffs: number;
  noFindingHandoffs: number;
  /** Worker notes and evidence-backed appends, excluding terminal handoffs. */
  workerFindings: number;
  lastUsefulAt: string | null;
  /** No-finding terminal handoffs since the class's latest useful one. */
  emptyStreak: number;
}

export interface AdminAutomataClassActivityInput {
  companionId: string;
  windowStartMs: number;
  /** Registry-terminal runs to probe for a matching Bus terminal handoff. */
  terminalRunIds: readonly string[];
}

export interface AdminAutomataClassActivityRead {
  companionId: string;
  windowStart: string;
  classes: readonly AdminAutomataClassActivity[];
  handoffRunIds: readonly string[];
}

/** Optional aggregate seam; a Bus port without it reports coverage as unknown. */
export interface AdminAutomataClassActivityPort {
  readClassActivity(input: AdminAutomataClassActivityInput): Promise<AdminAutomataClassActivityRead>;
}

type AdminAutomataClassCoverageReason =
  | 'unwired'
  | 'empty_useful_streak'
  | 'terminalization_gap';

type AdminAutomataClassCoverageHealth = 'healthy' | 'degraded' | 'idle' | 'excluded' | 'unknown';

interface AdminAutomataClassCoverageView {
  automatonClass: string;
  busEligibility: EffectiveAutomataClassDescriptor['busEligibility'];
  wired: boolean;
  busMode: 'bounded_loop' | 'single_pass' | null;
  exclusion: string | null;
  runs: { total: number; active: number; completed: number; failed: number; cancelled: number };
  outcomes: Partial<Record<AutomataRunOutcome, number>>;
  /** Lifecycle status-reason vocabulary only; free-form failure text is never shown. */
  failureReasons: Record<string, number>;
  /** Null when the Bus aggregate is unavailable: nothing is inferred as healthy. */
  handoffs: Omit<AdminAutomataClassActivity, 'automatonClass'> | null;
  terminalizationGaps: number | null;
  health: AdminAutomataClassCoverageHealth;
  degradationReasons: AdminAutomataClassCoverageReason[];
}

export interface AdminAutomataCoverage {
  available: boolean;
  windowStart: string;
  activityWindowMs: number;
  emptyRunThreshold: number;
  eligibleCount: number;
  wiredCount: number;
  classes: AdminAutomataClassCoverageView[];
  degradationReasons: AdminAutomataClassCoverageReason[];
}

const TERMINAL_STATUSES = new Set<AutomataRunRecord['status']>(['completed', 'failed', 'cancelled']);

function runTimeMs(run: AutomataRunRecord): number {
  return run.finishedAtMs ?? run.startedAtMs ?? run.createdAtMs;
}

/** Registry runs that fall inside the owner window. */
export function selectAutomataCoverageRuns(
  runs: readonly AutomataRunRecord[],
  windowStartMs: number,
): AutomataRunRecord[] {
  return runs.filter(run => !TERMINAL_STATUSES.has(run.status) || runTimeMs(run) >= windowStartMs);
}

/** Terminal runs of wired classes; each must have left a Bus terminal handoff. */
export function selectAutomataHandoffProbeRunIds(runs: readonly AutomataRunRecord[]): string[] {
  const wired = new Set<string>(AUTOMATA_CLASS_GOVERNED_ADAPTERS.map(entry => entry.automatonClass));
  return runs
    .filter(run => TERMINAL_STATUSES.has(run.status) && wired.has(run.automatonClass))
    .map(run => run.runId);
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

/**
 * Eligible-versus-wired coverage and learning health per class.
 *
 * A class degrades when it is eligible with no governed adapter, when its
 * latest `emptyRunThreshold` terminal handoffs in the window left nothing
 * useful, or when a registry-terminal run has no Bus terminal handoff.
 */
export function buildAutomataCoverage(input: {
  classes: readonly EffectiveAutomataClassDescriptor[];
  runs: readonly AutomataRunRecord[];
  activity: AdminAutomataClassActivityRead | null;
  policy: AutomataBusHealthOwnerPolicy;
  windowStartMs: number;
}): AdminAutomataCoverage {
  const adapters = new Map<string, (typeof AUTOMATA_CLASS_GOVERNED_ADAPTERS)[number]>(
    AUTOMATA_CLASS_GOVERNED_ADAPTERS.map(entry => [entry.automatonClass, entry]),
  );
  const activityByClass = new Map(
    (input.activity?.classes ?? []).map(entry => [entry.automatonClass, entry]),
  );
  const handoffRuns = new Set(input.activity?.handoffRunIds ?? []);
  const probed = new Set(selectAutomataHandoffProbeRunIds(input.runs));
  const views = input.classes.map((descriptor): AdminAutomataClassCoverageView => {
    const adapter = adapters.get(descriptor.id);
    const classRuns = input.runs.filter(run => run.automatonClass === descriptor.id);
    const runs = { total: classRuns.length, active: 0, completed: 0, failed: 0, cancelled: 0 };
    const outcomes: Partial<Record<AutomataRunOutcome, number>> = {};
    const failureReasons: Record<string, number> = {};
    let gaps = 0;
    for (const run of classRuns) {
      if (run.status === 'queued' || run.status === 'running') runs.active += 1;
      else runs[run.status] += 1;
      if (run.outcome) outcomes[run.outcome] = (outcomes[run.outcome] ?? 0) + 1;
      if (run.status === 'failed') increment(failureReasons, run.statusReason);
      if (probed.has(run.runId) && !handoffRuns.has(run.runId)) gaps += 1;
    }
    const activity = activityByClass.get(descriptor.id);
    const handoffs = input.activity
      ? {
        usefulHandoffs: activity?.usefulHandoffs ?? 0,
        noFindingHandoffs: activity?.noFindingHandoffs ?? 0,
        workerFindings: activity?.workerFindings ?? 0,
        lastUsefulAt: activity?.lastUsefulAt ?? null,
        emptyStreak: activity?.emptyStreak ?? 0,
      }
      : null;
    const reasons: AdminAutomataClassCoverageReason[] = [];
    const eligible = descriptor.busEligibility === 'eligible';
    if (eligible && !adapter) reasons.push('unwired');
    if (eligible && handoffs && handoffs.emptyStreak >= input.policy.emptyRunThreshold) {
      reasons.push('empty_useful_streak');
    }
    if (eligible && input.activity && gaps > 0) reasons.push('terminalization_gap');
    let health: AdminAutomataClassCoverageHealth;
    if (!eligible) health = 'excluded';
    else if (reasons.length > 0) health = 'degraded';
    else if (!handoffs) health = 'unknown';
    else if (handoffs.usefulHandoffs + handoffs.noFindingHandoffs === 0) health = 'idle';
    else health = 'healthy';
    return {
      automatonClass: descriptor.id,
      busEligibility: descriptor.busEligibility,
      wired: adapter !== undefined,
      busMode: adapter?.busMode ?? null,
      exclusion: adapter?.busMode === 'single_pass' ? adapter.exclusion : null,
      runs,
      outcomes,
      failureReasons,
      handoffs,
      terminalizationGaps: input.activity ? gaps : null,
      health,
      degradationReasons: reasons,
    };
  });
  const eligibleViews = views.filter(view => view.busEligibility === 'eligible');
  return {
    available: input.activity !== null,
    windowStart: new Date(input.windowStartMs).toISOString(),
    activityWindowMs: input.policy.activityWindowMs,
    emptyRunThreshold: input.policy.emptyRunThreshold,
    eligibleCount: eligibleViews.length,
    wiredCount: eligibleViews.filter(view => view.wired).length,
    classes: views,
    degradationReasons: [...new Set(views.flatMap(view => view.degradationReasons))],
  };
}
