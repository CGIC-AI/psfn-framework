// ── Free-time lanes (E8.1) ──
// Self-directed time for the companion: a bounded, budget-capped, multi-turn
// agent-loop session on an INTERNAL channel where she can explore, make
// something, think, try a tool, write something down — or do nothing at all.
// Two entry lanes share one block runner:
//
//   1. Quiet-hours lane — polls inside the episodicProcessing rest window
//      (uses the configured rest-window clock).
//   2. Idle lane — polls when no partner conversation is recently active.
//      Both lanes use the same partner-activity metadata guard; neither needs
//      an external conversation to create its own private opportunity.
//
// Before ANY spend, a deterministic gate (deterministic-gate primitive) runs
// with zero LLM cost: it blocks during recent partner activity, enforces a
// minimum interval between blocks, and caps blocks-per-day. A closed gate emits
// a typed skip event (scheduler.free_time.gate) carrying the reason + inputs so
// the Garden subsystem-health view shows exactly why a block did or did not run.
//
// Charter invariants:
// - 8.8 personal time / rest: rest windows are visible and configurable; a
//   skipped check burns no tokens (the gate is pure); personal time is not
//   hidden uncontrolled autonomy — every threshold is JSON-owned and every
//   block is recorded and visible in Garden.
// - 8.9 charge stewardship: a hard per-block budget (maxTurns + a background
//   charge-lane unit cap) bounds spend; exhaustion ends the block gracefully
//   with a visible reason.
// - law 14/15: no new self-modification surfaces or tool privileges. The block
//   invokes her NORMAL tools through the ordinary agent loop under existing
//   capability/trust policy — the OPPOSITE posture to restricted reflection.
// - 8.1-8.2 / law 19: the block runs on an `internal:free-time:` channel, which
//   keeps ordinary replies and the transcript private. Explicit companion
//   outreach remains available through the normal governed tools: candidate
//   appraisal or an owned open dyad, with live capability and broker checks.
//
// Artifacts go through her normal tools (journal, wiki, memory, scratchpad,
// media); the transcript itself lands in ordinary internal session storage.
// Replies are never automatically forwarded to chat. After an active block,
// a context note follows the workspace return/disclosure policy through
// appendContextSystemNote and the shared summarizer. Empty ("loafed") blocks
// are a valid outcome and surface nothing.

import { createComponentLogger } from '../../shared/logger.js';
import { resolveActiveTimezone } from '../../shared/time/active-timezone.js';
import type { EventBus } from '../../shared/event-bus.js';
import {
  evaluateDeterministicGate,
  type DeterministicGateDefinition,
  type GateDecision,
} from '../../shared/gating/deterministic-gate.js';
import type {
  EpisodicProcessingRestWindowConfig,
  FreeTimeConfig,
} from '../../system/config/scheduler-config.js';
import { REFLECTION_SILENT_TOKEN } from './reflection-policy.js';
import { evaluateRestWindowEligibility, type RestWindowEligibilityDecision } from './rest-window.js';
import { FREE_TIME_CHANNEL_PREFIX } from '../session/session-id.js';
import type { SessionEntry } from '../session/types.js';
import type { Scheduler } from './scheduler.js';
import type { FleetSlotStagger } from './types.js';
import { staggerFleetOrdinalWithinWindow } from './fleet-maintenance-coordinator.js';
import type { FreeTimeChooserOutcome, FreeTimeRestReason } from './free-time-chooser.js';
import type { FreeTimeLane } from './free-time-lane.js';
import {
  hasRecentFreeTimePartnerActivity,
  type FreeTimeActivityPort,
} from './free-time-activity.js';
import type { FreeTimeReturnPolicy, FreeTimeWorkspace } from './free-time-workspace-resolver.js';
import type { DisclosureDestination, DisclosureLineage } from '../cogsec/disclosure/index.js';
import { projectReturnNoteEvidence } from './return-note-projection.js';
import {
  returnPolicyToDisclosureDestination,
  routeReturnNote,
  type ContactDmSessionResolver,
} from './return-note-routing.js';

const log = createComponentLogger('FreeTime');

export const FREE_TIME_QUIET_HOURS_TASK_ID = 'free-time:quiet-hours';
export const FREE_TIME_QUIET_HOURS_TASK_NAME = 'Free Time (Quiet Hours)';
export const FREE_TIME_IDLE_TASK_ID = 'free-time:idle';
export const FREE_TIME_IDLE_TASK_NAME = 'Free Time (Idle)';

export const FREE_TIME_GATE_LANE = 'free_time';
export const FREE_TIME_GATE_EVENT = 'scheduler.free_time.gate';
export const FREE_TIME_BLOCK_EVENT = 'scheduler.free_time.block';

// Re-exported from the canonical session-identity module so the free-time
// partition prefix has a single source of truth across every call site (the
// sibling workspace resolver and existing consumers import it from here).
export { FREE_TIME_CHANNEL_PREFIX };
export const FREE_TIME_BLOCK_NOTE_SOURCE = 'free_time_block';
export const FREE_TIME_RETURN_NOTE_SOURCE = 'free_time_return';

/**
 * Default lane-independent continuity segment. Absent a resolved workspace, all
 * free time runs on ONE continuous private "wandering" session shared by both
 * trigger lanes (bible §10.4). This is a placeholder identity: the
 * FreeTimeWorkspaceResolver, once wired via
 * FreeTimeRuntimeOptions.resolveWorkspaceChannelId, supplies the project- or
 * room-specific continuity session instead.
 */
export const FREE_TIME_DEFAULT_WORKSPACE_SEGMENT = 'wandering';

const MINUTE_MS = 60_000;
/** A finite sentinel for "no prior activity / no prior block" gate inputs. */
const NO_PRIOR_SENTINEL_MINUTES = 10 ** 9;

export type { FreeTimeLane } from './free-time-lane.js';

/**
 * Resolve the internal channel/session id for a free-time block from a chosen
 * WORKSPACE segment — never from the trigger lane. An empty or missing segment
 * falls back to the single default continuity session so quiet-hours and idle
 * always converge on the same transcript.
 */
export function freeTimeWorkspaceChannelId(workspaceSegment?: string | null): string {
  const segment = (workspaceSegment ?? '').trim();
  if (segment.length === 0) {
    return `${FREE_TIME_CHANNEL_PREFIX}${FREE_TIME_DEFAULT_WORKSPACE_SEGMENT}`;
  }
  if (
    /^(?:internal|subagent|shard):/u.test(segment)
    || !/^[a-z0-9][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)*$/u.test(segment)
  ) {
    throw new Error(
      'Invalid free-time workspace segment: expected lowercase alphanumeric, underscore, or hyphen segments',
    );
  }
  return `${FREE_TIME_CHANNEL_PREFIX}${segment}`;
}

function localDateKey(timestampMs: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(timestampMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// ── Lane eligibility ──
// Free time owns its private continuity session. Only the quiet-hours clock
// limits this lane; partner activity is an independent pre-spend guard below.

export interface FreeTimeLaneEligibilityInput {
  lane: FreeTimeLane;
  restWindow: EpisodicProcessingRestWindowConfig;
  nowMs?: number;
}

export function evaluateFreeTimeLaneEligibility(
  input: FreeTimeLaneEligibilityInput,
): RestWindowEligibilityDecision {
  return evaluateRestWindowEligibility({
    config: input.lane === 'quiet_hours'
      ? input.restWindow
      : { ...input.restWindow, enabled: false },
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  });
}

// ── Pre-spend deterministic gate ──
// Ordered hard closes: recent partner activity (never during active
// conversation) → minimum block interval → daily block cap. Opens only when the
// lane is eligible. Pure: no I/O, no LLM spend.

export interface FreeTimeGateInput {
  laneEligible: boolean;
  partnerRecentlyActive: boolean;
  minutesSinceLastBlock: number;
  blocksToday: number;
  minBlockIntervalMinutes: number;
  maxBlocksPerDay: number;
}

export function buildFreeTimeGateDefinition(input: {
  minBlockIntervalMinutes: number;
  maxBlocksPerDay: number;
}): DeterministicGateDefinition {
  return {
    lane: FREE_TIME_GATE_LANE,
    blockWhen: [
      {
        input: 'partnerRecentlyActive',
        comparator: 'gte',
        threshold: 1,
        reason: 'partner_recently_active',
      },
      {
        input: 'minutesSinceLastBlock',
        comparator: 'lt',
        threshold: Math.max(0, input.minBlockIntervalMinutes),
        reason: 'min_block_interval',
      },
      {
        input: 'blocksToday',
        comparator: 'gte',
        threshold: Math.max(1, input.maxBlocksPerDay),
        reason: 'daily_block_cap',
      },
    ],
    openWhenAny: [{ input: 'laneEligible', comparator: 'gte', threshold: 1 }],
    closedReason: 'lane_not_eligible',
    openReason: 'open',
  };
}

export function evaluateFreeTimeGate(input: FreeTimeGateInput): GateDecision {
  const definition = buildFreeTimeGateDefinition({
    minBlockIntervalMinutes: input.minBlockIntervalMinutes,
    maxBlocksPerDay: input.maxBlocksPerDay,
  });
  return evaluateDeterministicGate(definition, {
    laneEligible: input.laneEligible ? 1 : 0,
    partnerRecentlyActive: input.partnerRecentlyActive ? 1 : 0,
    minutesSinceLastBlock: input.minutesSinceLastBlock,
    blocksToday: input.blocksToday,
  });
}

// ── Framing ──
// The operator-editable open seed is gentle permission; a closing line
// establishes that nothing is required and how to end the block. The ordinary
// agent loop supplies the authoritative base identity system prompt.

const FREE_TIME_CLOSING = 'There is no task and nothing to prove. When you feel done — or if you '
  + `would simply rather rest — reply with only "${REFLECTION_SILENT_TOKEN}" and the time is `
  + 'yours to end. Anything you make or note goes into your own journal, wiki, memory, or notes '
  + 'through your normal tools. Your replies and this private transcript are not automatically sent '
  + 'to anyone. You may choose to contact a known companion through your normal governed messaging tools, '
  + 'with the usual consent, availability, and capability checks. Reaching out and resting are both optional.';

export function buildFreeTimeFramingPrompt(input: {
  seedText: string;
  projectContext?: string | null;
}): string {
  const seed = input.seedText.trim();
  return [
    '[Free time]',
    seed,
    ...(input.projectContext?.trim() ? [input.projectContext.trim()] : []),
    FREE_TIME_CLOSING,
  ].join('\n\n');
}

/**
 * A short, safe framing line for a companion-chosen workspace (jp36.2.1.2). The
 * chooser already resolved the workspace facts; the block opens on the chosen
 * activity rather than an LRU auto-select. Project bodies are loaded by her own
 * tools during the block, not preloaded here (bible §10.2).
 */
export function buildChosenWorkspaceFraming(
  workspace: FreeTimeWorkspace,
  label: string,
): string {
  const context = workspace.workContext.kind;
  const scope = context === 'private'
    ? 'This is your own private time.'
    : context === 'room'
      ? 'This work is for an ordinary room you already keep.'
      : 'This is publication work you already own.';
  return [
    `You chose: ${label}.`,
    scope,
  ].join('\n');
}

export function buildFreeTimeContinuationPrompt(): string {
  return [
    '[Free time — still yours]',
    'You still have some time to yourself. Keep going with whatever you are doing, follow it '
    + 'somewhere new, or let it rest.',
    `If you are done or would rather just be, reply with only "${REFLECTION_SILENT_TOKEN}".`,
  ].join('\n');
}

function isStopSignal(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return trimmed.length === 0 || trimmed === REFLECTION_SILENT_TOKEN;
}

// ── Block runner ──

export type FreeTimeBlockEndReason =
  | 'loafed'
  | 'companion_stopped'
  | 'turns_exhausted'
  | 'charge_budget_exhausted'
  // The companion chose rest at the chooser (bible §10.2): the block ends with
  // no free-time turn — the chooser's single model call is the only spend.
  | 'rested'
  // A prior rest silenced this quiet period; the block never prompted (§10.2
  // silence persistence). Distinct from `rested` so telemetry can tell a fresh
  // rest from a suppressed re-check.
  | 'rest_suppressed';

export interface FreeTimeBlockResult {
  lane: FreeTimeLane;
  channelId: string;
  turnsUsed: number;
  /** True when at least one turn produced real content (not a stop signal). */
  activity: boolean;
  endReason: FreeTimeBlockEndReason;
  /**
   * Why a `rested` block rested: `companion_rested` is a genuine choice; every
   * other {@link FreeTimeRestReason} is the chooser failing closed. Present
   * exactly when endReason === 'rested' so telemetry, the Garden, and the
   * companion-facing note can tell rest-by-choice from rest-by-failure
   * (psfn-framework-hrmrq.69).
   */
  restReason?: FreeTimeRestReason;
  spentChargeUnits: number;
  startedAtMs: number;
  endedAtMs: number;
}

export interface FreeTimeBlockRunInput {
  lane: FreeTimeLane;
  channelId: string;
  maxTurns: number;
  maxChargeUnits: number;
  framingPrompt: string;
  /** Cumulative background-lane charge units spent so far (read before each turn). */
  readSpentChargeUnits: () => number;
  /** Invoke one free-time turn on the internal channel; returns her response. */
  invokeTurn: (input: { turnIndex: number; content: string }) => Promise<{ content: string }>;
  now?: () => number;
}

/**
 * Run one bounded free-time block. Enforces the hard per-block budget BEFORE
 * each turn: turn cap AND background charge-lane unit cap. Budget exhaustion
 * ends the block gracefully with a visible reason; genuine turn errors are NOT
 * swallowed — they propagate to the scheduler, which records the failure.
 * A stop signal on the very first turn is a valid zero-output "loaf".
 */
export async function runFreeTimeBlock(input: FreeTimeBlockRunInput): Promise<FreeTimeBlockResult> {
  const now = input.now ?? (() => Date.now());
  const startedAtMs = now();
  const maxTurns = Math.max(1, Math.floor(input.maxTurns));
  const maxChargeUnits = Math.max(0, input.maxChargeUnits);

  let turnsUsed = 0;
  let activity = false;
  let endReason: FreeTimeBlockEndReason = 'turns_exhausted';

  for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
    const spentBefore = input.readSpentChargeUnits();
    if (spentBefore >= maxChargeUnits) {
      endReason = 'charge_budget_exhausted';
      break;
    }

    const content = turnIndex === 0 ? input.framingPrompt : buildFreeTimeContinuationPrompt();
    const response = await input.invokeTurn({ turnIndex, content });
    turnsUsed += 1;

    if (isStopSignal(response.content)) {
      endReason = turnIndex === 0 ? 'loafed' : 'companion_stopped';
      break;
    }
    activity = true;
  }

  return {
    lane: input.lane,
    channelId: input.channelId,
    turnsUsed,
    activity,
    endReason,
    spentChargeUnits: input.readSpentChargeUnits(),
    startedAtMs,
    endedAtMs: now(),
  };
}

export function buildFreeTimeBlockNote(result: FreeTimeBlockResult): string {
  // A `rested` outcome is only a choice when the chooser actually produced one.
  // Every other rest reason is the chooser failing closed (disabled, timeout,
  // error, unparseable output, invalid option, resolve failure) — telling the
  // companion that was "a valid way to spend the time" would misrepresent her
  // own agency back to her (psfn-framework-hrmrq.69). Fail closed: an
  // unattributed rest is NOT affirmed as a choice.
  const failedRest = result.endReason === 'rested' && result.restReason !== 'companion_rested';
  const outcomeLine = failedRest
    ? `Lane: ${result.lane}. Turns used: ${result.turnsUsed}. Outcome: rested (${result.restReason ?? 'reason unrecorded'} — not a choice).`
    : `Lane: ${result.lane}. Turns used: ${result.turnsUsed}. Outcome: ${result.endReason}.`;
  const activityLine = result.activity
    ? 'Something was made or explored this block.'
    : failedRest
      ? 'The free-time chooser did not run to completion, so no choice was made this block — this was a system failure, not you choosing to rest.'
      : 'Nothing was made this block — resting is a valid way to spend the time.';
  return [
    '[Free-time block]',
    outcomeLine,
    activityLine,
    `Charge spent (background lane): ${result.spentChargeUnits} unit(s).`,
    'The private block transcript was not forwarded; any explicit outreach uses the normal governed messaging tools.',
  ].join('\n');
}

// ── Runtime registration ──

export interface FreeTimeSessionManagerPort extends FreeTimeActivityPort {
  getRecentMessages(channelId: string, limit?: number): SessionEntry[];
  getRecentSessionEntries?(channelId: string, limit: number): SessionEntry[];
  appendSystemNote(channelId: string, note: string, source?: string): void;
  appendContextSystemNote(channelId: string, note: string, source?: string): void;
}

export interface FreeTimeBlockRecord extends FreeTimeBlockResult {
  returnSurfaced: boolean;
  recordedAtMs: number;
}

export interface FreeTimeRuntimeOptions {
  scheduler: Scheduler;
  sessionManager: FreeTimeSessionManagerPort;
  config: FreeTimeConfig;
  /** Rest window used by the quiet-hours lane; shared with episodicProcessing. */
  restWindow: EpisodicProcessingRestWindowConfig;
  /**
   * Fleet position and stagger window (scheduler.json `fleetStagger`). When
   * present, each lane's poll phase is offset by the companion's fleet ordinal
   * so a fleet rolled out together does not start free-time blocks in the
   * same instant. Absent for a single-companion deployment.
   */
  fleetStagger?: FleetSlotStagger;
  eventBus?: EventBus;
  /**
   * Runs the whole block inside a charge context (charge-policy 'background'
   * lane) and hands the runner a reader for cumulative background-lane spend.
   * Wire to runWithChargeContext + getRunChargeSnapshot in composition.
   */
  runBlock: (input: {
    lane: FreeTimeLane;
    run: (readSpentChargeUnits: () => number) => Promise<FreeTimeBlockResult>;
  }) => Promise<FreeTimeBlockResult>;
  /**
   * Invoke one free-time turn through the ordinary agent loop on the internal
   * channel (full persona, her normal tools, existing policy). Wire to
   * agentLoop.handleMessage in composition.
   */
  invokeTurn: (input: {
    lane: FreeTimeLane;
    channelId: string;
    audience: 'self';
    turnIndex: number;
    content: string;
  }) => Promise<{ content: string }>;
  /**
   * Shared session summarizer for the "while you were away" note. Wire to
   * summarizeRecentSessionEntries with purpose 'free_time_return' and the
   * freeTime.returnNote.summaryMaxTokens budget. Never bespoke.
   */
  summarizeActivity?: (input: {
    channelId: string;
    entries: readonly SessionEntry[];
  }) => Promise<string>;
  /**
   * Resolve the return note's DISCLOSURE DESTINATION for a completed block
   * (bible §15.2 / §10.8). The destination-eligible summarizer projection
   * (jp36.2.3.2) filters the block's evidence to only what THIS destination may
   * lawfully receive before any summary is generated, so a note bound for one
   * contact's DM can never be summarized from another contact's material. Wire
   * to the workspace return policy → `DisclosureDestination` mapping owned by
   * the routing sibling (jp36.2.3.1). ABSENT, the note keeps the full-fidelity
   * private/self form (`companion_self`) — no regression while routing lands.
   * This seam can only NARROW what the summarizer sees, never widen it.
   */
  resolveReturnDestination?: () => DisclosureDestination;
  /**
   * Resolve the captured per-turn disclosure lineage for one free-time
   * transcript entry, so the projection can assess each entry against the
   * return destination (bible §9). `undefined` for an entry fails closed — that
   * entry is dropped for every outward destination (private/self keeps it). When
   * this port is absent, every entry has undefined lineage, so any outward
   * destination collapses to the private/self form.
   */
  resolveEntryDisclosureLineage?: (entry: SessionEntry) => DisclosureLineage | undefined;
  /**
   * Resolve a contact-anchored return note's `contactId` to that contact's DM
   * session id (bible §10.8: contact-anchored work returns to that exact DM,
   * never "an admin" or the latest private session). The routing NEVER addresses
   * a private channel id directly — it resolves through this seam. ABSENT (or
   * returning `null`), a contact-anchored note fails closed to a content-free
   * private/self note rather than a wrong-destination append. Manifest v2
   * (jp36.2.4) wires the concrete contact→DM resolution.
   */
  resolveContactDmSessionId?: ContactDmSessionResolver;
  /**
   * Resolve the lane-independent continuity session for a free-time block.
   * The scheduler trigger lane (quiet-hours vs idle) MUST NOT determine
   * transcript identity — both lanes resume the SAME chosen workspace session
   * (bible §10.4). Wire to FreeTimeWorkspaceResolver in composition (return its
   * resolved workspace session id); absent, free time runs on the single
   * default continuity session (`freeTimeWorkspaceChannelId()`) shared across
   * lanes. Resolved lazily, only once a block is about to spend.
   */
  resolveWorkspaceChannelId?: () => string;
  /** Resume one active personal project from the existing personal-wiki tier. */
  loadProjectContext?: () => Promise<string | null>;
  /**
   * Companion free-time chooser (bible §10.2, jp36.2.1.2). When wired, it
   * SUPERSEDES the LRU `loadProjectContext` auto-select: the companion picks
   * rest / private wander / resume / create through one cheap background call.
   * Rest or a silence-suppressed re-check ends the block with no free-time turn;
   * a chosen workspace drives the block's framing. Fails closed to rest on any
   * error, so it can never force a workspace. When absent, legacy behavior
   * (LRU project context) applies unchanged. The lane→continuity-session merge
   * that consumes the chosen `workspace.sessionId` is the sibling jp36.2.2.
   */
  chooseWorkspace?: (input: {
    lane: FreeTimeLane;
    nowMs: number;
  }) => Promise<FreeTimeChooserOutcome>;
  /** Optional recorder for the Garden read surface (recent blocks + spend). */
  recordBlock?: (record: FreeTimeBlockRecord) => void;
  now?: () => number;
}

interface FreeTimeLaneCadenceState {
  lastBlockAtMs?: number;
  blocksTodayKey?: string;
  blocksToday: number;
  /**
   * bead 75ci: the local-day key on which a block ended in silence
   * (loafed/companion_stopped). While it matches the current day the gate stays
   * closed for the remainder of the day, so a silent exit is not re-prompted up
   * to the daily cap. Naturally clears on day rollover (a new dayKey no longer
   * matches).
   */
  silencedForDayKey?: string;
}

/**
 * Build the publication-STATE return note (bible §10.8 rows 4-5): a workspace
 * state update that carries NO transcript content and no partner disclosure. It
 * lands on the workspace's own internal continuity session, never a partner DM.
 */
function buildPublicationStateNote(): string {
  return [
    '[Publication workspace update]',
    'During some free time, I made a little progress on a publication project of mine.',
    'This note comes from the runtime, not from you; mention it or not, however you like.',
  ].join('\n');
}

/**
 * Surface the "while you were away" return note for a completed ACTIVE block,
 * routed by the RESOLVED WORKSPACE return policy (bible §10.8) rather than the
 * latest eligible session. The disclosure DESTINATION handed to the summarizer
 * projection and the append TARGET are derived from the SAME return policy, so a
 * note bound for one contact's DM is both summarized from and delivered to that
 * exact DM — route and destination can never disagree.
 *
 * Fail-closed (charter / bible §20.4): an unresolvable contact/room, or a
 * projection collapse (nothing eligible for the outward destination), degrades
 * to a content-free private/self note — never a wrong-destination append. The
 * note is always an ATTRIBUTED SYSTEM note (never Participant speech, hard
 * invariant, prior misattribution incident) and is non-initiating (a passive
 * context note; it surfaces only when a human next replies, never pushed).
 */
async function surfaceReturnNote(
  options: FreeTimeRuntimeOptions,
  privateSelfSessionId: string,
  freeTimeChannel: string,
  result: FreeTimeBlockResult,
  routing?: { returnPolicy: FreeTimeReturnPolicy; disclosureCeiling?: DisclosureDestination },
): Promise<boolean> {
  if (!result.activity) return false;

  const transcript = options.sessionManager.getRecentSessionEntries
    ? options.sessionManager.getRecentSessionEntries(freeTimeChannel, 32)
    : options.sessionManager.getRecentMessages(freeTimeChannel, 32);
  const assistantEntries = transcript.filter(entry => entry.role === 'assistant');
  if (assistantEntries.length === 0) return false;

  // The note's disclosure destination comes from the resolved workspace return
  // policy (the FreeTimeReturnPolicy → DisclosureDestination mapping this bead
  // owns). Absent a chosen workspace (legacy / chooser unwired), the optional
  // `resolveReturnDestination` seam supplies it, defaulting to the private-self
  // sink so there is no regression while richer workspaces land.
  const requestedDestination: DisclosureDestination = routing
    ? returnPolicyToDisclosureDestination(routing.returnPolicy, routing.disclosureCeiling)
    : (options.resolveReturnDestination?.() ?? { kind: 'companion_self' });

  // Route AND destination from the same source: `route.destination` feeds the
  // projection content gate; `route.targetSessionId` is the append target.
  const route = routeReturnNote(requestedDestination, {
    privateSelfSessionId,
    workspaceSessionId: freeTimeChannel,
    ...(options.resolveContactDmSessionId
      ? { resolveContactDmSessionId: options.resolveContactDmSessionId }
      : {}),
  });

  // Publication: a STATE update on the workspace's own session — no transcript
  // content, no partner disclosure (bible §10.8). Short-circuit before any
  // summarization so a broad private transcript can never reach it.
  if (route.isPublicationState) {
    log.debug('Free-time return-note routed to publication state update', {
      workspaceChannelId: freeTimeChannel,
      targetSessionId: route.targetSessionId,
      requestedDestinationKind: requestedDestination.kind,
      reason: route.reason,
    });
    options.sessionManager.appendContextSystemNote(
      route.targetSessionId,
      buildPublicationStateNote(),
      FREE_TIME_RETURN_NOTE_SOURCE,
    );
    return true;
  }

  // Destination-eligible summarizer projection (jp36.2.3.2, bible §15.2/§10.8):
  // filter the block's evidence to only what the note's DESTINATION may lawfully
  // receive BEFORE any summary is generated. Only run when an outward target was
  // actually resolved (`contentAllowed`) and a summarizer is wired; otherwise the
  // note stays a content-free "spent some time on my own" self-disclosure. The
  // projection rides the landed CogSec disclosure decision layer (jp36.1) — no
  // parallel classification here.
  let summary = '';
  let projectionCollapsed = false;
  let projectionMode: string = 'content_free';
  let eligibleCount = 0;
  if (route.contentAllowed && options.summarizeActivity) {
    const projection = projectReturnNoteEvidence({
      evidence: assistantEntries.map(entry => ({
        entry,
        lineage: options.resolveEntryDisclosureLineage?.(entry),
      })),
      destination: route.destination,
    });
    projectionCollapsed = projection.collapsed;
    projectionMode = projection.mode;
    eligibleCount = projection.eligibleEntries.length;
    if (projection.mode === 'content' && projection.eligibleEntries.length > 0) {
      try {
        summary = (await options.summarizeActivity({
          channelId: freeTimeChannel,
          entries: projection.eligibleEntries,
        })).trim();
      } catch (error) {
        // The summary is an enrichment; its failure must not block the return
        // note. Surfaced via warn, never swallowed silently.
        log.warn('Free-time activity summary failed; surfacing note without it', {
          channelId: freeTimeChannel,
          error: String(error),
        });
      }
    }
  }

  // Deliver eligible content to the resolved outward/self target ONLY when a real
  // summary survived the projection. Any other outcome — unresolvable target,
  // projection collapse, or an empty summary — is a content-free note that keeps
  // to the companion's own private-self session, never the outward destination.
  const deliverContent = summary.length > 0 && !projectionCollapsed && route.contentAllowed;
  const targetSessionId = deliverContent ? route.targetSessionId : privateSelfSessionId;

  log.debug('Free-time return-note routed', {
    channelId: freeTimeChannel,
    requestedDestinationKind: requestedDestination.kind,
    routedDestinationKind: route.destination.kind,
    targetSessionId,
    deliverContent,
    projectionMode,
    projectionCollapsed,
    eligibleEntries: eligibleCount,
    totalAssistantEntries: assistantEntries.length,
    reason: route.reason,
  });

  const note = [
    '[While you were away]',
    'During some free time, I spent a little while on my own.',
    ...(deliverContent ? [`Here is what I got up to: ${summary}`] : []),
    'This note comes from the runtime, not from you; mention it or not, however you like.',
  ].join('\n');

  options.sessionManager.appendContextSystemNote(
    targetSessionId,
    note,
    FREE_TIME_RETURN_NOTE_SOURCE,
  );
  return true;
}

function makeLaneHandler(
  options: FreeTimeRuntimeOptions,
  lane: FreeTimeLane,
  state: FreeTimeLaneCadenceState,
): () => Promise<void> {
  const now = options.now ?? (() => Date.now());
  // Lane-independent continuity: identity comes from the chosen workspace, never
  // from `lane`. The default segment resolves to one shared continuity session
  // (bible §10.4), and the optional resolver seam substitutes a project/room
  // workspace session — identically for both lanes.
  const defaultChannelId = freeTimeWorkspaceChannelId();
  const resolveWorkspaceChannelId = options.resolveWorkspaceChannelId
    ?? (() => defaultChannelId);
  const dayKeyTimeZone = options.restWindow.timeZone === 'local'
    ? resolveActiveTimezone()
    : options.restWindow.timeZone;

  return async () => {
    const nowMs = now();

    // Daily block counter resets on local-day rollover.
    const dayKey = localDateKey(nowMs, dayKeyTimeZone);
    if (state.blocksTodayKey !== dayKey) {
      state.blocksTodayKey = dayKey;
      state.blocksToday = 0;
    }

    // bead 75ci: if a prior block today ended because she chose silence
    // (loafed/companion_stopped), do not bother her again for the remainder of
    // the day, regardless of the block interval or daily cap.
    if (state.silencedForDayKey === dayKey) {
      if (options.eventBus) {
        void options.eventBus.emit(FREE_TIME_GATE_EVENT, {
          lane: FREE_TIME_GATE_LANE,
          outcome: 'skipped',
          reason: `${lane}:silenced_after_stop`,
          inputs: {},
          timestamp: nowMs,
          channelId: defaultChannelId,
        });
      }
      log.debug('Free-time block skipped: silenced after a prior silent exit today', { lane });
      return;
    }

    const activeConversationGuardMinutes = lane === 'idle'
      ? options.config.idle.minIdleMinutes
      : Math.max(1, options.restWindow.inactivityThresholdMinutes);
    const minutesSinceLastBlock = state.lastBlockAtMs === undefined
      ? NO_PRIOR_SENTINEL_MINUTES
      : Math.max(0, nowMs - state.lastBlockAtMs) / MINUTE_MS;
    const laneDecision = evaluateFreeTimeLaneEligibility({
      lane,
      restWindow: options.restWindow,
      nowMs,
    });
    const partnerRecentlyActive = hasRecentFreeTimePartnerActivity(options.sessionManager, {
      lookbackMs: activeConversationGuardMinutes * MINUTE_MS,
      nowMs,
    });
    const gate = evaluateFreeTimeGate({
      laneEligible: laneDecision.allowed,
      partnerRecentlyActive,
      minutesSinceLastBlock,
      blocksToday: state.blocksToday,
      minBlockIntervalMinutes: options.config.minBlockIntervalMinutes,
      maxBlocksPerDay: options.config.maxBlocksPerDay,
    });

    if (options.eventBus) {
      void options.eventBus.emit(FREE_TIME_GATE_EVENT, {
        lane: FREE_TIME_GATE_LANE,
        outcome: gate.open ? 'ran' : 'skipped',
        reason: gate.open ? `${lane}:open` : `${lane}:${gate.reason}`,
        inputs: gate.inputs,
        timestamp: nowMs,
        sessionId: defaultChannelId,
        channelId: defaultChannelId,
      });
    }

    if (!gate.open) {
      log.debug('Free-time block skipped', { lane, reason: gate.reason });
      return;
    }
    // ── Companion chooser (jp36.2.1.2) ──
    // When wired, the chooser supersedes the LRU auto-select: the companion
    // picks rest / private wander / resume / create through ONE cheap background
    // call. It is only reached once the deterministic gate has opened, so a
    // silenced re-check is rare (the min-block interval usually holds first) —
    // but silence persistence is the authoritative "not again this quiet period"
    // guard regardless of interval config.
    let chosen: FreeTimeChooserOutcome | undefined;
    if (options.chooseWorkspace) {
      chosen = await options.chooseWorkspace({ lane, nowMs });
    }

    // Resolve the continuity workspace ONLY now that a block is committed to
    // spend, so an eventual resolver is never invoked on gate-skipped ticks.
    // Both lanes call the same resolver, so both converge on the same session.
    const channelId = resolveWorkspaceChannelId();

    if (chosen?.kind === 'suppressed') {
      // A prior rest silences this quiet period: no prompt, no spend, no note.
      // Advance the min-block interval so the deterministic gate also holds, and
      // record only a lightweight block event (no channel note / recordBlock) so
      // repeated suppressed re-checks cannot spam the internal transcript.
      state.lastBlockAtMs = nowMs;
      if (options.eventBus) {
        void options.eventBus.emit(FREE_TIME_BLOCK_EVENT, {
          lane,
          channelId,
          turnsUsed: 0,
          activity: false,
          endReason: 'rest_suppressed',
          spentChargeUnits: 0,
          maxChargeUnits: options.config.budget.maxChargeUnits,
          maxTurns: options.config.budget.maxTurns,
          startedAtMs: nowMs,
          endedAtMs: nowMs,
          returnSurfaced: false,
          timestamp: nowMs,
        });
      }
      log.debug('Free-time block suppressed by rest-window silence', { lane });
      return;
    }

    let result: FreeTimeBlockResult;
    if (chosen?.kind === 'rest') {
      // Rest is a first-class outcome (bible §6.7/§10.2): the block ends here
      // with NO free-time turn. The chooser's single call is the only spend;
      // there is no second model call.
      // Info, not debug: rest-by-failure (chooser_error/timeout/…) must be
      // visible in ordinary logs, not only under debug (psfn-framework-hrmrq.69).
      log.info('Free-time block ended at chooser (rest)', { lane, restReason: chosen.reason });
      result = {
        lane,
        channelId,
        turnsUsed: 0,
        activity: false,
        endReason: 'rested',
        restReason: chosen.reason,
        spentChargeUnits: 0,
        startedAtMs: nowMs,
        endedAtMs: nowMs,
      };
    } else {
      const projectContext = chosen?.kind === 'workspace'
        ? buildChosenWorkspaceFraming(chosen.workspace, chosen.label)
        : (options.loadProjectContext ? await options.loadProjectContext() : null);
      const framingPrompt = buildFreeTimeFramingPrompt({
        seedText: options.config.seedText,
        projectContext,
      });

      result = await options.runBlock({
        lane,
        run: (readSpentChargeUnits) => runFreeTimeBlock({
          lane,
          channelId,
          maxTurns: options.config.budget.maxTurns,
          maxChargeUnits: options.config.budget.maxChargeUnits,
          framingPrompt,
          readSpentChargeUnits,
          invokeTurn: ({ turnIndex, content }) => options.invokeTurn({
            lane,
            channelId,
            audience: 'self',
            turnIndex,
            content,
          }),
          now,
        }),
      });
    }

    state.lastBlockAtMs = result.endedAtMs;
    // A rest outcome consumed a free-time opportunity but not a full block; it
    // does not draw down the daily block budget (silence persistence, not the
    // day cap, prevents re-prompting this period).
    if (result.endReason !== 'rested') {
      state.blocksToday += 1;
    }
    // bead 75ci: she chose silence and free time ended — close the gate for the
    // rest of the day so she is not re-prompted up to the daily cap.
    if (result.endReason === 'loafed' || result.endReason === 'companion_stopped') {
      state.silencedForDayKey = dayKey;
    }

    // Provenance marker on the internal transcript (inspectable, tagged).
    options.sessionManager.appendSystemNote(
      channelId,
      buildFreeTimeBlockNote(result),
      FREE_TIME_BLOCK_NOTE_SOURCE,
    );

    // Route the return note by the RESOLVED WORKSPACE return policy (bible §10.8),
    // never the trigger lane or the latest eligible session. A chosen workspace
    // carries its own return policy + disclosure ceiling; absent one (chooser
    // unwired / legacy), routing falls back to the private-self seam.
    const returnRouting = chosen?.kind === 'workspace'
      ? {
        returnPolicy: chosen.workspace.returnPolicy,
        disclosureCeiling: chosen.workspace.retrievalPolicy.disclosureCeiling,
      }
      : undefined;
    let returnSurfaced = false;
    try {
      returnSurfaced = await surfaceReturnNote(options, channelId, channelId, result, returnRouting);
    } catch (error) {
      log.error('Free-time return-surfacing failed; block outcome stands', {
        lane,
        error: String(error),
      });
    }

    log.info('Free-time block completed', {
      lane,
      turnsUsed: result.turnsUsed,
      activity: result.activity,
      endReason: result.endReason,
      ...(result.restReason !== undefined ? { restReason: result.restReason } : {}),
      spentChargeUnits: result.spentChargeUnits,
      returnSurfaced,
    });

    if (options.recordBlock) {
      options.recordBlock({
        ...result,
        returnSurfaced,
        recordedAtMs: nowMs,
      });
    }

    if (options.eventBus) {
      void options.eventBus.emit(FREE_TIME_BLOCK_EVENT, {
        lane: result.lane,
        channelId: result.channelId,
        turnsUsed: result.turnsUsed,
        activity: result.activity,
        endReason: result.endReason,
        ...(result.restReason !== undefined ? { restReason: result.restReason } : {}),
        spentChargeUnits: result.spentChargeUnits,
        maxChargeUnits: options.config.budget.maxChargeUnits,
        maxTurns: options.config.budget.maxTurns,
        startedAtMs: result.startedAtMs,
        endedAtMs: result.endedAtMs,
        returnSurfaced,
        timestamp: nowMs,
      });
    }
  };
}

/**
 * Poll registration for a free-time lane. A fleet member's poll phase is
 * offset by its manifest ordinal, spread evenly across the stagger window
 * clamped to one poll interval (a longer offset would only wrap around).
 */
function freeTimePollRegistration(
  intervalMs: number,
  stagger: FleetSlotStagger | undefined,
): { skipFirstRun: true; phaseOffsetMs?: number } {
  if (!stagger) return { skipFirstRun: true };
  const phaseOffsetMs = staggerFleetOrdinalWithinWindow({
    manifestOrdinal: stagger.manifestOrdinal,
    fleetSize: stagger.fleetSize,
    windowStartMs: 0,
    windowEndMs: Math.min(stagger.windowMs, intervalMs),
  });
  return { skipFirstRun: true, phaseOffsetMs };
}

export function registerFreeTimeTasks(options: FreeTimeRuntimeOptions): void {
  if (!options.config.enabled) {
    log.info('Free-time lanes disabled by scheduler.json freeTime.enabled');
    return;
  }

  // One SHARED cadence state across both lanes: the min-block-interval and
  // daily-block cap bound total free-time spend, not per-lane spend. Scheduler
  // tick execution is sequential, so a block in one lane updates this state
  // before the other lane's gate is evaluated in the same tick.
  const sharedState: FreeTimeLaneCadenceState = { blocksToday: 0 };

  if (options.config.quietHours.enabled) {
    const intervalMs = Math.max(1_000, options.config.quietHours.checkIntervalMs);
    options.scheduler.register({
      id: FREE_TIME_QUIET_HOURS_TASK_ID,
      name: FREE_TIME_QUIET_HOURS_TASK_NAME,
      type: 'every',
      intervalMs,
      availability: 'do_not_disturb',
      handler: makeLaneHandler(options, 'quiet_hours', sharedState),
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    }, freeTimePollRegistration(intervalMs, options.fleetStagger));
  }

  if (options.config.idle.enabled) {
    const intervalMs = Math.max(1_000, options.config.idle.checkIntervalMs);
    options.scheduler.register({
      id: FREE_TIME_IDLE_TASK_ID,
      name: FREE_TIME_IDLE_TASK_NAME,
      type: 'every',
      intervalMs,
      availability: 'do_not_disturb',
      handler: makeLaneHandler(options, 'idle', sharedState),
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    }, freeTimePollRegistration(intervalMs, options.fleetStagger));
  }

  log.info('Free-time lanes registered', {
    quietHoursEnabled: options.config.quietHours.enabled,
    idleEnabled: options.config.idle.enabled,
    maxTurns: options.config.budget.maxTurns,
    maxChargeUnits: options.config.budget.maxChargeUnits,
    minBlockIntervalMinutes: options.config.minBlockIntervalMinutes,
    maxBlocksPerDay: options.config.maxBlocksPerDay,
  });
}
