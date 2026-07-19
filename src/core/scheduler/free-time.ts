// ── Free-time lanes (E8.1) ──
// Self-directed time for the companion: a bounded, budget-capped, multi-turn
// agent-loop session on an INTERNAL channel where she can explore, make
// something, think, try a tool, write something down — or do nothing at all.
// Two entry lanes share one block runner:
//
//   1. Quiet-hours lane — polls inside the episodicProcessing rest window
//      (reuses the ambient-presence eligibility WITH the rest window).
//   2. Idle lane — polls after a long partner-inactivity gap (reuses the same
//      ambient-presence eligibility WITHOUT the rest window). Detection is not
//      duplicated: both lanes call evaluateAmbientPresenceEligibility.
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
//   isInternalSessionId() marks internal, so it can never dispatch outward to a
//   partner channel. Any outward message would ride the existing
//   proactive-outbound gates, which fail closed on internal channels.
//
// Outputs are durable only: whatever she writes goes through her normal tools
// (journal, wiki, memory, scratchpad, media); the transcript itself lands in
// ordinary session storage on the internal channel (inspectable). Nothing goes
// directly to chat. After a block WITH activity, a "while you were away" context
// note is placed on the partner's session via appendContextSystemNote + the
// shared summarizer so she can mention it naturally on return. Empty ("loafed")
// blocks are a valid outcome and surface nothing.

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
import { HEARTBEAT_SILENT_REFLECTION_TOKEN } from './heartbeat-policy.js';
import {
  evaluateAmbientPresenceEligibility,
  type AmbientPresenceDecision,
} from './ambient-presence.js';
import type { StartupSessionMetadata } from '../session/manager.js';
import { FREE_TIME_CHANNEL_PREFIX } from '../session/session-id.js';
import type { SessionEntry } from '../session/types.js';
import type { Scheduler } from './scheduler.js';
import { conversationalEntryFromSessionMetadata } from './session-metadata-preflight.js';

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

export type FreeTimeLane = 'quiet_hours' | 'idle';

/**
 * Resolve the internal channel/session id for a free-time block from a chosen
 * WORKSPACE segment — never from the trigger lane. An empty or missing segment
 * falls back to the single default continuity session so quiet-hours and idle
 * always converge on the same transcript.
 */
export function freeTimeWorkspaceChannelId(workspaceSegment?: string | null): string {
  const segment = (workspaceSegment ?? '').trim();
  return `${FREE_TIME_CHANNEL_PREFIX}${segment.length > 0 ? segment : FREE_TIME_DEFAULT_WORKSPACE_SEGMENT}`;
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
// Both lanes reuse the ambient-presence evaluator, which already owns the
// session/internal/privacy-boundary checks, the idle-gap threshold, and the
// optional rest-window sub-check. The quiet-hours lane passes the rest window;
// the idle lane passes none.

export interface FreeTimeLaneEligibilityInput {
  lane: FreeTimeLane;
  session: StartupSessionMetadata | null;
  recentEntries: readonly SessionEntry[];
  restWindow: EpisodicProcessingRestWindowConfig;
  idleMinIdleMinutes: number;
  nowMs?: number;
}

export function evaluateFreeTimeLaneEligibility(
  input: FreeTimeLaneEligibilityInput,
): AmbientPresenceDecision {
  if (input.lane === 'quiet_hours') {
    return evaluateAmbientPresenceEligibility({
      session: input.session,
      recentEntries: input.recentEntries,
      restWindow: input.restWindow,
      // The rest window's own inactivityThreshold (evaluated against last
      // partner activity) enforces inactivity for this lane; keep the ambient
      // gap check permissive so the rest window is the authority.
      minIdleMs: 0,
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    });
  }
  return evaluateAmbientPresenceEligibility({
    session: input.session,
    recentEntries: input.recentEntries,
    // No rest window: idle free time can happen at any time of day.
    minIdleMs: Math.max(0, input.idleMinIdleMinutes) * MINUTE_MS,
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  });
}

// ── Pre-spend deterministic gate ──
// Ordered hard closes: recent partner activity (never during active
// conversation) → minimum block interval → daily block cap. Opens only when the
// lane is eligible. Pure: no I/O, no LLM spend.

export interface FreeTimeGateInput {
  laneEligible: boolean;
  minutesSincePartnerActivity: number;
  minutesSinceLastBlock: number;
  blocksToday: number;
  activeConversationGuardMinutes: number;
  minBlockIntervalMinutes: number;
  maxBlocksPerDay: number;
}

export function buildFreeTimeGateDefinition(input: {
  activeConversationGuardMinutes: number;
  minBlockIntervalMinutes: number;
  maxBlocksPerDay: number;
}): DeterministicGateDefinition {
  return {
    lane: FREE_TIME_GATE_LANE,
    blockWhen: [
      {
        input: 'minutesSincePartnerActivity',
        comparator: 'lt',
        threshold: Math.max(0, input.activeConversationGuardMinutes),
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
    activeConversationGuardMinutes: input.activeConversationGuardMinutes,
    minBlockIntervalMinutes: input.minBlockIntervalMinutes,
    maxBlocksPerDay: input.maxBlocksPerDay,
  });
  return evaluateDeterministicGate(definition, {
    laneEligible: input.laneEligible ? 1 : 0,
    minutesSincePartnerActivity: input.minutesSincePartnerActivity,
    minutesSinceLastBlock: input.minutesSinceLastBlock,
    blocksToday: input.blocksToday,
  });
}

// ── Framing ──
// The operator-editable open seed is gentle permission; a closing line
// establishes that nothing is required and how to end the block. The ordinary
// agent loop supplies the authoritative base identity system prompt.

const FREE_TIME_CLOSING = 'There is no task and nothing to prove. When you feel done — or if you '
  + `would simply rather rest — reply with only "${HEARTBEAT_SILENT_REFLECTION_TOKEN}" and the time is `
  + 'yours to end. Anything you make or note goes into your own journal, wiki, memory, or notes '
  + 'through your normal tools; nothing here is sent to anyone.';

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

export function buildFreeTimeContinuationPrompt(): string {
  return [
    '[Free time — still yours]',
    'You still have some time to yourself. Keep going with whatever you are doing, follow it '
    + 'somewhere new, or let it rest.',
    `If you are done or would rather just be, reply with only "${HEARTBEAT_SILENT_REFLECTION_TOKEN}".`,
  ].join('\n');
}

function isStopSignal(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return trimmed.length === 0 || trimmed === HEARTBEAT_SILENT_REFLECTION_TOKEN;
}

// ── Block runner ──

export type FreeTimeBlockEndReason =
  | 'loafed'
  | 'companion_stopped'
  | 'turns_exhausted'
  | 'charge_budget_exhausted';

export interface FreeTimeBlockResult {
  lane: FreeTimeLane;
  channelId: string;
  turnsUsed: number;
  /** True when at least one turn produced real content (not a stop signal). */
  activity: boolean;
  endReason: FreeTimeBlockEndReason;
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
  return [
    '[Free-time block]',
    `Lane: ${result.lane}. Turns used: ${result.turnsUsed}. Outcome: ${result.endReason}.`,
    result.activity
      ? 'Something was made or explored this block.'
      : 'Nothing was made this block — resting is a valid way to spend the time.',
    `Charge spent (background lane): ${result.spentChargeUnits} unit(s).`,
    'No outbound message was sent; any artifacts went to durable stores through normal tools.',
  ].join('\n');
}

// ── Runtime registration ──

export interface FreeTimeSessionManagerPort {
  resolveStartupSessionMetadata(behavior?: 'reuse_latest_session'): StartupSessionMetadata | null;
  getRecentMessages(channelId: string, limit?: number): SessionEntry[];
  getRecentSessionEntries?(channelId: string, limit: number): SessionEntry[];
  appendSystemNote(channelId: string, note: string, source?: string): void;
  appendContextSystemNote(channelId: string, note: string, source?: string): void;
}

export interface FreeTimeBlockRecord extends FreeTimeBlockResult {
  partnerSessionId: string;
  returnSurfaced: boolean;
  recordedAtMs: number;
}

export interface FreeTimeRuntimeOptions {
  scheduler: Scheduler;
  sessionManager: FreeTimeSessionManagerPort;
  config: FreeTimeConfig;
  /** Rest window used by the quiet-hours lane; shared with episodicProcessing. */
  restWindow: EpisodicProcessingRestWindowConfig;
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
  /** Optional recorder for the Garden read surface (recent blocks + spend). */
  recordBlock?: (record: FreeTimeBlockRecord) => void;
  now?: () => number;
}

interface FreeTimeLaneCadenceState {
  lastBlockAtMs?: number;
  blocksTodayKey?: string;
  blocksToday: number;
}

function partnerActivityMinutes(decision: AmbientPresenceDecision, nowMs: number): number {
  const at = decision.lastUserActivityAtMs;
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return NO_PRIOR_SENTINEL_MINUTES;
  }
  return Math.max(0, nowMs - at) / MINUTE_MS;
}

function evaluateFreeTimeGatePreflight(input: {
  lane: FreeTimeLane;
  session: StartupSessionMetadata | null;
  restWindow: EpisodicProcessingRestWindowConfig;
  idleMinIdleMinutes: number;
  nowMs: number;
  minutesSinceLastBlock: number;
  blocksToday: number;
  activeConversationGuardMinutes: number;
  minBlockIntervalMinutes: number;
  maxBlocksPerDay: number;
}): GateDecision | null {
  const evaluateLane = (recentEntries: readonly SessionEntry[]): AmbientPresenceDecision =>
    evaluateFreeTimeLaneEligibility({
      lane: input.lane,
      session: input.session,
      recentEntries,
      restWindow: input.restWindow,
      idleMinIdleMinutes: input.idleMinIdleMinutes,
      nowMs: input.nowMs,
    });
  const evaluateGate = (laneDecision: AmbientPresenceDecision): GateDecision =>
    evaluateFreeTimeGate({
      laneEligible: laneDecision.allowed,
      minutesSincePartnerActivity: partnerActivityMinutes(laneDecision, input.nowMs),
      minutesSinceLastBlock: input.minutesSinceLastBlock,
      blocksToday: input.blocksToday,
      activeConversationGuardMinutes: input.activeConversationGuardMinutes,
      minBlockIntervalMinutes: input.minBlockIntervalMinutes,
      maxBlocksPerDay: input.maxBlocksPerDay,
    });

  const structuralDecision = evaluateLane([]);
  if (
    !structuralDecision.allowed
    && (
      structuralDecision.reason === 'no_recent_session'
      || structuralDecision.reason === 'internal_session'
      || structuralDecision.reason === 'privacy_boundary'
    )
  ) {
    return evaluateGate(structuralDecision);
  }

  const latestConversation = conversationalEntryFromSessionMetadata(input.session);
  if (latestConversation?.role === 'user') {
    const gate = evaluateGate(evaluateLane([latestConversation]));
    if (!gate.open) return gate;
  }

  const latestActivityMinutes = input.session && Number.isFinite(input.session.timestamp)
    ? Math.max(0, input.nowMs - input.session.timestamp) / MINUTE_MS
    : null;
  // An old latest-any-role timestamp proves every partner turn is older too.
  // Only then may cadence gates run early; partner recency must retain first
  // priority whenever the metadata cannot disprove it.
  if (
    latestActivityMinutes === null
    || latestActivityMinutes < Math.max(0, input.activeConversationGuardMinutes)
  ) {
    return null;
  }
  const cadenceGate = evaluateFreeTimeGate({
    laneEligible: false,
    minutesSincePartnerActivity: latestActivityMinutes,
    minutesSinceLastBlock: input.minutesSinceLastBlock,
    blocksToday: input.blocksToday,
    activeConversationGuardMinutes: input.activeConversationGuardMinutes,
    minBlockIntervalMinutes: input.minBlockIntervalMinutes,
    maxBlocksPerDay: input.maxBlocksPerDay,
  });
  return cadenceGate.reason === 'min_block_interval' || cadenceGate.reason === 'daily_block_cap'
    ? cadenceGate
    : null;
}

async function surfaceReturnNote(
  options: FreeTimeRuntimeOptions,
  partnerSessionId: string,
  freeTimeChannel: string,
  result: FreeTimeBlockResult,
): Promise<boolean> {
  if (!result.activity) return false;

  const transcript = options.sessionManager.getRecentSessionEntries
    ? options.sessionManager.getRecentSessionEntries(freeTimeChannel, 32)
    : options.sessionManager.getRecentMessages(freeTimeChannel, 32);
  const assistantEntries = transcript.filter(entry => entry.role === 'assistant');
  if (assistantEntries.length === 0) return false;

  let summary = '';
  if (options.summarizeActivity) {
    try {
      summary = (await options.summarizeActivity({
        channelId: freeTimeChannel,
        entries: assistantEntries,
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

  const note = [
    '[While you were away]',
    'During some free time, I spent a little while on my own.',
    ...(summary ? [`Here is what I got up to: ${summary}`] : []),
    'This note comes from the runtime, not from you; mention it or not, however you like.',
  ].join('\n');

  options.sessionManager.appendContextSystemNote(
    partnerSessionId,
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
    const session = options.sessionManager.resolveStartupSessionMetadata('reuse_latest_session');
    const sessionId = session?.sessionId;

    // Daily block counter resets on local-day rollover.
    const dayKey = localDateKey(nowMs, dayKeyTimeZone);
    if (state.blocksTodayKey !== dayKey) {
      state.blocksTodayKey = dayKey;
      state.blocksToday = 0;
    }

    const activeConversationGuardMinutes = lane === 'idle'
      ? options.config.idle.minIdleMinutes
      : Math.max(1, options.restWindow.inactivityThresholdMinutes);
    const minutesSinceLastBlock = state.lastBlockAtMs === undefined
      ? NO_PRIOR_SENTINEL_MINUTES
      : Math.max(0, nowMs - state.lastBlockAtMs) / MINUTE_MS;
    let gate = evaluateFreeTimeGatePreflight({
      lane,
      session,
      restWindow: options.restWindow,
      idleMinIdleMinutes: options.config.idle.minIdleMinutes,
      nowMs,
      minutesSinceLastBlock,
      blocksToday: state.blocksToday,
      activeConversationGuardMinutes,
      minBlockIntervalMinutes: options.config.minBlockIntervalMinutes,
      maxBlocksPerDay: options.config.maxBlocksPerDay,
    });

    if (!gate) {
      const recentEntries = sessionId
        ? options.sessionManager.getRecentMessages(sessionId, 16)
        : [];
      const laneDecision = evaluateFreeTimeLaneEligibility({
        lane,
        session,
        recentEntries,
        restWindow: options.restWindow,
        idleMinIdleMinutes: options.config.idle.minIdleMinutes,
        nowMs,
      });
      gate = evaluateFreeTimeGate({
        laneEligible: laneDecision.allowed,
        minutesSincePartnerActivity: partnerActivityMinutes(laneDecision, nowMs),
        minutesSinceLastBlock,
        blocksToday: state.blocksToday,
        activeConversationGuardMinutes,
        minBlockIntervalMinutes: options.config.minBlockIntervalMinutes,
        maxBlocksPerDay: options.config.maxBlocksPerDay,
      });
    }

    if (options.eventBus) {
      void options.eventBus.emit(FREE_TIME_GATE_EVENT, {
        lane: FREE_TIME_GATE_LANE,
        outcome: gate.open ? 'ran' : 'skipped',
        reason: gate.open ? `${lane}:open` : `${lane}:${gate.reason}`,
        inputs: gate.inputs,
        timestamp: nowMs,
        ...(sessionId
          ? { sessionId, channelId: defaultChannelId }
          : { channelId: defaultChannelId }),
      });
    }

    if (!gate.open) {
      log.debug('Free-time block skipped', { lane, reason: gate.reason });
      return;
    }
    if (!sessionId) {
      // Defensive: lane eligibility requires a session, so this is unreachable,
      // but the return-surfacing target must exist before we spend.
      log.debug('Free-time block skipped: no partner session to surface to', { lane });
      return;
    }

    // Resolve the continuity workspace ONLY now that a block is committed to
    // spend, so an eventual resolver is never invoked on skipped ticks. Both
    // lanes call the same resolver, so both converge on the same session.
    const channelId = resolveWorkspaceChannelId();

    const projectContext = options.loadProjectContext
      ? await options.loadProjectContext()
      : null;
    const framingPrompt = buildFreeTimeFramingPrompt({
      seedText: options.config.seedText,
      projectContext,
    });

    const result = await options.runBlock({
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

    state.lastBlockAtMs = result.endedAtMs;
    state.blocksToday += 1;

    // Provenance marker on the internal transcript (inspectable, tagged).
    options.sessionManager.appendSystemNote(
      channelId,
      buildFreeTimeBlockNote(result),
      FREE_TIME_BLOCK_NOTE_SOURCE,
    );

    let returnSurfaced = false;
    try {
      returnSurfaced = await surfaceReturnNote(options, sessionId, channelId, result);
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
      spentChargeUnits: result.spentChargeUnits,
      returnSurfaced,
    });

    if (options.recordBlock) {
      options.recordBlock({
        ...result,
        partnerSessionId: sessionId,
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
    options.scheduler.register({
      id: FREE_TIME_QUIET_HOURS_TASK_ID,
      name: FREE_TIME_QUIET_HOURS_TASK_NAME,
      type: 'every',
      intervalMs: Math.max(1_000, options.config.quietHours.checkIntervalMs),
      handler: makeLaneHandler(options, 'quiet_hours', sharedState),
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    }, { skipFirstRun: true });
  }

  if (options.config.idle.enabled) {
    options.scheduler.register({
      id: FREE_TIME_IDLE_TASK_ID,
      name: FREE_TIME_IDLE_TASK_NAME,
      type: 'every',
      intervalMs: Math.max(1_000, options.config.idle.checkIntervalMs),
      handler: makeLaneHandler(options, 'idle', sharedState),
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    }, { skipFirstRun: true });
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
