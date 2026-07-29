import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import type { SkillsRuntime } from './runtime.js';
import type { SkillOwnership, SkillSource } from './types.js';
import { detectDestructiveSkillContentReplace, type ManagedSkillRecord } from './store.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { IntakeEnvelopeSnapshot } from '../../shared/contracts/intake-envelope.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import type { IntakeSinkGate } from '../../core/cogsec/intake/sink-gates.js';
import { INTAKE_FIREWALL_NOTICE_TEMPLATES } from '../../core/cogsec/intake-firewall-notice-templates.js';
import type { CapabilityTier } from '../../system/config/runtime-config-contracts.js';
import {
  withCapabilityRequirement,
  resolveSkillToolCapabilityRequirement,
} from '../../system/capabilities/requirements.js';
import type {
  ApprovalQueuePort,
  ConfirmationQueueEntry,
} from '../../system/capabilities/approval-queue-port.js';

const SKILL_TOOL_ACTION_NAMES = [
  'list',
  'skill_list',
  'view',
  'skill_view',
  'stats',
  'skill_stats',
  'create',
  'skill_create',
  'update',
  'skill_update',
  'history',
  'rollback',
] as const;
const SKILL_TOOL_ACTION_HELP = [
  'list',
  'view',
  'stats',
  'create',
  'update',
  'history',
  'rollback',
].join(', ');

type SkillToolActionName = (typeof SKILL_TOOL_ACTION_NAMES)[number];
type SkillToolAction = 'list' | 'view' | 'stats' | 'create' | 'update' | 'history' | 'rollback';
type SkillWriteAction = 'create' | 'update' | 'rollback';

function resolveSkillOwnership(source: SkillSource): SkillOwnership {
  switch (source) {
    case 'custom':
      return 'personal';
    case 'bundled':
    case 'extra':
      return 'deployment';
  }
}

interface SkillListParams {
  includeSkipped?: boolean;
  includeContent?: boolean;
}

interface SkillToolParams extends SkillListParams {
  action?: SkillToolActionName;
  name?: string;
  category?: string;
  content?: string;
  description?: string;
  version?: number;
  reason?: string;
}

/**
 * Charter 9.5 category-2 governance over managed skill writes: the capability
 * tier decides whether a write applies directly or queues as an operator
 * proposal on the shared Garden confirmation queue. Skill writes fail closed
 * when this is not wired — there is no ungoverned write path.
 */
export interface SkillWriteGovernance {
  getCapabilityTier: () => CapabilityTier;
  confirmationQueue?: ApprovalQueuePort;
}

type SkillWriteGovernanceDecision =
  | { kind: 'apply' }
  | { kind: 'queue'; queue: ApprovalQueuePort; tier: CapabilityTier; cause: 'tier' | 'destructive' }
  | { kind: 'refuse'; message: string };

/**
 * Tiering (deliberately conservative, per bead psfn-framework-9xe2n):
 * - governance unwired: every write refuses (fail closed — the pre-existing
 *   "unwired means allowed" posture was the bug).
 * - non-autonomous tier: every write (create/update/rollback) queues for
 *   operator confirmation; refuse when no queue is configured.
 * - autonomous tier: creates (purely additive), non-destructive updates, and
 *   rollbacks (restore of a journaled prior version) apply directly — every
 *   one is journaled with provenance and reversible via rollback, which is
 *   what justifies the lighter tier for conditionally-loaded skills.
 *   Heuristically destructive updates NEVER apply silently: they queue, with
 *   no self-service override flag.
 */
function resolveSkillWriteGovernanceDecision(
  governance: SkillWriteGovernance | undefined,
  action: SkillWriteAction,
  destructive: boolean,
): SkillWriteGovernanceDecision {
  if (!governance) {
    return {
      kind: 'refuse',
      message: `skill action=${action} is refused: skill write governance (capability tier + confirmation queue) is not wired. Managed skill writes fail closed without governance.`,
    };
  }
  const tier = governance.getCapabilityTier();
  const queue = governance.confirmationQueue;
  if (tier !== 'autonomous') {
    if (!queue) {
      return {
        kind: 'refuse',
        message: `skill action=${action} in ${tier} tier requires confirmation queue support, but no queue is configured.`,
      };
    }
    return { kind: 'queue', queue, tier, cause: 'tier' };
  }
  if (destructive) {
    if (!queue) {
      return {
        kind: 'refuse',
        message: `Destructive skill ${action} blocked: the change removes most of the existing skill body and requires operator confirmation, but no confirmation queue is configured.`,
      };
    }
    return { kind: 'queue', queue, tier, cause: 'destructive' };
  }
  return { kind: 'apply' };
}

function normalizeReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function requireProposalString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Approved skill proposal is missing required field "${key}"`);
  }
  return value;
}

function applyApprovedSkillWrite(
  runtime: SkillsRuntime,
  kind: SkillWriteAction,
  params: Record<string, unknown>,
): ManagedSkillRecord {
  const store = runtime.getStore();
  const name = requireProposalString(params, 'name');
  const reason = normalizeReason(params.reason);
  const provenance = { updatedBy: 'admin:confirmation', ...(reason ? { reason } : {}) };
  const description = typeof params.description === 'string' ? params.description : undefined;

  let record: ManagedSkillRecord;
  switch (kind) {
    case 'create': {
      record = store.create({
        name,
        category: requireProposalString(params, 'category'),
        content: requireProposalString(params, 'content'),
        ...(description !== undefined ? { description } : {}),
      }, provenance);
      break;
    }
    case 'update': {
      const existing = store.getByName(name);
      if (!existing) {
        throw new Error(`Skill "${name}" no longer exists; the approved update cannot apply`);
      }
      const baseVersion = params.baseVersion;
      if (typeof baseVersion !== 'number') {
        throw new Error('Approved skill update proposal is missing its numeric baseVersion');
      }
      if (existing.version !== baseVersion) {
        throw new Error(
          `Skill "${name}" changed since this proposal (now v${existing.version}, proposed against v${baseVersion}); re-propose against the current version`,
        );
      }
      record = store.update({
        name,
        content: requireProposalString(params, 'content'),
        ...(description !== undefined ? { description } : {}),
      }, provenance);
      break;
    }
    case 'rollback': {
      const version = params.version;
      if (typeof version !== 'number') {
        throw new Error('Approved skill rollback proposal requires a numeric version');
      }
      record = store.rollback(name, version, provenance);
      break;
    }
  }
  runtime.invalidate();
  return record;
}

function enqueueSkillWriteProposal(
  runtime: SkillsRuntime,
  queue: ApprovalQueuePort,
  proposal: {
    kind: SkillWriteAction;
    scope: string;
    params: Record<string, unknown>;
    companionReason: string;
  },
): ConfirmationQueueEntry {
  return queue.enqueue(
    {
      method: `skills.skill.${proposal.kind}`,
      action: proposal.kind,
      scope: proposal.scope,
      params: proposal.params,
      companionReason: proposal.companionReason,
    },
    async (approvedParams: Record<string, unknown>) => {
      applyApprovedSkillWrite(runtime, proposal.kind, approvedParams);
    },
  );
}

function queuedSkillWriteResult(
  kind: SkillWriteAction,
  name: string,
  entry: ConfirmationQueueEntry,
  cause: 'tier' | 'destructive',
): ReturnType<typeof textResult> {
  return textResult(JSON.stringify({
    action: 'queued',
    kind,
    name,
    proposalId: entry.id,
    cause,
    message: `Skill ${kind} queued for operator confirmation (id: ${entry.id}). `
      + (cause === 'destructive'
        ? 'The change would remove most of the existing skill body, so it needs approval on the admin Confirmations page.'
        : 'Skill writes at this capability tier need approval on the admin Confirmations page.'),
  }, null, 2));
}

export interface SkillWriteIntakeRuntime {
  getIntakeSinkGate: () => IntakeSinkGate | null;
  getIntakeScreening: () => IntakeScreeningService | null;
  getActiveTurnIntakeEnvelopes: () => readonly IntakeEnvelopeSnapshot[];
}

interface ScreenedSkillWrite {
  allowed: boolean;
  content: string;
  description?: string;
}

async function screenSkillWrite(
  action: 'create' | 'update',
  input: {
    content: string;
    description?: string;
  },
  intake: SkillWriteIntakeRuntime | undefined,
): Promise<ScreenedSkillWrite> {
  if (!intake) {
    return { allowed: true, ...input };
  }

  const gate = intake.getIntakeSinkGate();
  const screening = intake.getIntakeScreening();
  if (!gate) {
    if (screening) {
      throw new Error('Skill write intake screening is wired without the canonical sink gate');
    }
    return { allowed: true, ...input };
  }

  if (!screening) {
    const unscreenedDecision = gate.evaluate('skill_write', [], {
      tool: 'skill',
      action,
      screening: 'unavailable',
    });
    return { allowed: unscreenedDecision.allowed, ...input };
  }

  const screenedContent = await screening.screen(input.content, {
    sourceClass: 'tool_output',
    origin: { ref: `tool:skill:${action}:content` },
    scope: 'strict',
  });
  const screenedDescription = input.description !== undefined
    ? await screening.screen(input.description, {
      sourceClass: 'tool_output',
      origin: { ref: `tool:skill:${action}:description` },
      scope: 'strict',
    })
    : null;
  const activeTurnEnvelopes = intake.getActiveTurnIntakeEnvelopes();
  const proposedContentEnvelopes = [
    ...activeTurnEnvelopes,
    screenedContent.snapshot,
    ...(screenedDescription ? [screenedDescription.snapshot] : []),
  ];
  const decision = gate.evaluate('skill_write', proposedContentEnvelopes, {
    tool: 'skill',
    action,
    activeTurnEnvelopeCount: activeTurnEnvelopes.length,
    screenedFieldCount: screenedDescription ? 2 : 1,
  });
  return {
    allowed: decision.allowed,
    content: screenedContent.effectiveText,
    ...(screenedDescription
      ? { description: screenedDescription.effectiveText }
      : {}),
  };
}

function normalizeSkillAction(params: SkillToolParams): SkillToolAction {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (!rawAction) {
    const hasNonListParams = Object.entries(params).some(([key, value]) => (
      key !== 'action'
      && key !== 'includeSkipped'
      && key !== 'includeContent'
      && value !== undefined
    ));
    if (!hasNonListParams) {
      return 'list';
    }
    throw new Error(`action is required unless using the default list behavior (${SKILL_TOOL_ACTION_HELP})`);
  }

  switch (rawAction) {
    case 'list':
    case 'skill_list':
      return 'list';
    case 'view':
    case 'skill_view':
      return 'view';
    case 'stats':
    case 'skill_stats':
      return 'stats';
    case 'create':
    case 'skill_create':
      return 'create';
    case 'update':
    case 'skill_update':
      return 'update';
    case 'history':
      return 'history';
    case 'rollback':
      return 'rollback';
    default:
      throw new Error(`action must be one of: ${SKILL_TOOL_ACTION_HELP}`);
  }
}

function buildSkillListPayload(runtime: SkillsRuntime, params: SkillListParams): Record<string, unknown> {
  const snapshot = runtime.getSnapshot();
  const evaluations = runtime.listSkillEvaluations();
  const includeSkipped = params.includeSkipped ?? true;
  const includeContent = params.includeContent ?? false;
  const includedNames = new Set(snapshot.includedSkills.map(skill => skill.name));
  const categorySummary = runtime.listCategorySummary();

  return {
    generatedAt: snapshot.generatedAt,
    signature: snapshot.signature,
    configEnabled: snapshot.configEnabled,
    managedOwnership: runtime.getManagedOwnership(),
    budget: snapshot.budget,
    scannedFiles: snapshot.scannedFiles,
    loadedSkills: snapshot.loadedSkills,
    categories: categorySummary.map(({ category, total, included }) => ({
      category,
      total,
      included,
    })),
    includedInPrompt: snapshot.includedSkills.map(skill => ({
      name: skill.name,
      category: skill.category,
      description: skill.description,
      version: skill.version ?? null,
      always: skill.always,
      source: skill.source,
      ownership: resolveSkillOwnership(skill.source),
      path: skill.relativePath,
      requires: skill.requires,
    })),
    skills: evaluations.map(({ entry, eligibility }) => ({
      name: entry.name,
      category: entry.category,
      description: entry.description,
      version: entry.version ?? null,
      createdAt: entry.createdAt ?? null,
      updatedAt: entry.updatedAt ?? null,
      source: entry.source,
      ownership: resolveSkillOwnership(entry.source),
      path: entry.relativePath,
      inPromptIndex: includedNames.has(entry.name),
      eligible: eligibility.eligible,
      reasons: eligibility.reasons,
      requires: entry.requires,
      ...(includeContent ? { content: entry.content } : {}),
    })),
    ...(includeSkipped
      ? {
        skipped: snapshot.skipped.map(item => ({
          kind: item.kind,
          name: item.name,
          source: item.source,
          path: item.relativePath,
          reason: item.reason,
          details: item.details ?? [],
        })),
      }
      : {}),
  };
}

function buildSkillMetadata(runtime: SkillsRuntime, name: string): Record<string, unknown> | null {
  const result = runtime.findSkill(name);
  if (!result) return null;
  const { entry, eligible } = result;
  const snapshot = runtime.getSnapshot();
  const includedNames = new Set(snapshot.includedSkills.map(skill => skill.name));
  return {
    name: entry.name,
    category: entry.category ?? null,
    description: entry.description,
    version: entry.version ?? null,
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
    source: entry.source,
    ownership: resolveSkillOwnership(entry.source),
    path: entry.relativePath,
    inPromptIndex: includedNames.has(entry.name),
    eligible: eligible.eligible,
    reasons: eligible.reasons,
    requires: entry.requires,
  };
}

function buildStatsTotals(stats: ReturnType<SkillsRuntime['listSkillUsageStats']>): Record<string, unknown> {
  const totals = stats.reduce((accumulator, item) => {
    accumulator.recordedSkills += 1;
    accumulator.invocationCount += item.invocationCount;
    accumulator.successCount += item.successCount;
    accumulator.failureCount += item.failureCount;
    if (item.averageDurationMs !== null && item.durationSampleCount > 0) {
      accumulator.durationSampleCount += item.durationSampleCount;
      accumulator.totalDurationMs += item.averageDurationMs * item.durationSampleCount;
    }
    return accumulator;
  }, {
    recordedSkills: 0,
    invocationCount: 0,
    successCount: 0,
    failureCount: 0,
    durationSampleCount: 0,
    totalDurationMs: 0,
  });

  return {
    recordedSkills: totals.recordedSkills,
    invocationCount: totals.invocationCount,
    successCount: totals.successCount,
    failureCount: totals.failureCount,
    successRate: totals.invocationCount > 0
      ? totals.successCount / totals.invocationCount
      : null,
    averageDurationMs: totals.durationSampleCount > 0
      ? totals.totalDurationMs / totals.durationSampleCount
      : null,
  };
}

function buildSkillStatsPayload(runtime: SkillsRuntime, name?: string): Record<string, unknown> {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (normalizedName) {
    const skill = buildSkillMetadata(runtime, normalizedName);
    const lookupName = typeof skill?.name === 'string' ? skill.name : normalizedName;
    const stats = runtime.getSkillUsageStats(lookupName);
    const status = skill
      ? (stats ? 'ok' : 'no_stats')
      : (stats ? 'stats_without_loaded_skill' : 'not_found');

    return {
      action: 'stats',
      scope: 'skill',
      status,
      name: lookupName,
      skill,
      stats,
      message: stats
        ? null
        : skill
          ? `No skill usage stats recorded for "${lookupName}".`
          : `Skill "${lookupName}" was not found and no usage stats are recorded for it.`,
    };
  }

  const snapshot = runtime.getSnapshot();
  const evaluations = runtime.listSkillEvaluations();
  const includedNames = new Set(snapshot.includedSkills.map(skill => skill.name));
  const stats = runtime.listSkillUsageStats();
  const statsByName = new Map(stats.map(item => [item.name.toLowerCase(), item]));
  const loadedSkillNames = new Set(evaluations.map(({ entry }) => entry.name.toLowerCase()));
  const recordedWithoutLoadedSkillCount = stats
    .filter(item => !loadedSkillNames.has(item.name.toLowerCase()))
    .length;

  return {
    action: 'stats',
    scope: 'list',
    generatedAt: snapshot.generatedAt,
    signature: snapshot.signature,
    managedOwnership: runtime.getManagedOwnership(),
    totals: buildStatsTotals(stats),
    recordedWithoutLoadedSkillCount,
    skills: evaluations.map(({ entry, eligibility }) => ({
      name: entry.name,
      category: entry.category ?? null,
      description: entry.description,
      version: entry.version ?? null,
      source: entry.source,
      ownership: resolveSkillOwnership(entry.source),
      path: entry.relativePath,
      inPromptIndex: includedNames.has(entry.name),
      eligible: eligibility.eligible,
      reasons: eligibility.reasons,
      stats: statsByName.get(entry.name.toLowerCase()) ?? null,
    })),
  };
}

function buildSkillViewPayload(runtime: SkillsRuntime, name: string): Record<string, unknown> | null {
  const result = runtime.findSkill(name);
  if (!result) {
    return null;
  }

  const { entry, eligible } = result;
  return {
    name: entry.name,
    category: entry.category,
    description: entry.description,
    version: entry.version ?? null,
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
    source: entry.source,
    ownership: resolveSkillOwnership(entry.source),
    path: entry.relativePath,
    always: entry.always,
    requires: entry.requires,
    eligibility: {
      eligible: eligible.eligible,
      reasons: eligible.reasons,
      missingBinaries: eligible.missingBinaries,
      missingEnv: eligible.missingEnv,
      missingConfig: eligible.missingConfig,
      disabledByConfig: eligible.disabledByConfig,
    },
    content: entry.content,
  };
}

export function createSkillTool(
  runtime: SkillsRuntime,
  intake?: SkillWriteIntakeRuntime,
  governance?: SkillWriteGovernance,
): SubstrateAgentTool {
  const tool: SubstrateAgentTool = {
    name: 'skill',
    label: 'skill',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.skill,
    parameters: Type.Object({
      action: Type.Optional(Type.Union(SKILL_TOOL_ACTION_NAMES.map((action) => Type.Literal(action)), {
        description:
          'Skill action. Defaults to list when omitted and no action-specific parameters are provided.',
      })),
      includeSkipped: Type.Optional(Type.Boolean({
        description: 'Optional for action=list. Include filtered/omitted skills with reasons.',
      })),
      includeContent: Type.Optional(Type.Boolean({
        description: 'Optional for action=list. Include full SKILL.md body content for included skills.',
      })),
      name: Type.Optional(Type.String({
        minLength: 1,
        description: 'Required for action=view|create|update|history|rollback. Optional for action=stats; omit to list summaries.',
      })),
      category: Type.Optional(Type.String({
        minLength: 1,
        description: 'Required for action=create. Category folder name.',
      })),
      content: Type.Optional(Type.String({
        minLength: 1,
        description: 'Required for action=create|update. Markdown skill instructions.',
      })),
      description: Type.Optional(Type.String({
        description: 'Optional one-line summary used in prompt index.',
      })),
      version: Type.Optional(Type.Number({
        description: 'Required for action=rollback: the journaled version to restore. Optional for action=history: return that version with its full document.',
      })),
      reason: Type.Optional(Type.String({
        description: 'Optional short rationale recorded as provenance for action=create|update|rollback.',
      })),
    }),
    execute: async (_toolCallId: string, params: SkillToolParams) => {
      try {
        switch (normalizeSkillAction(params)) {
          case 'list':
            return textResult(JSON.stringify(buildSkillListPayload(runtime, params), null, 2));
          case 'view': {
            const name = typeof params.name === 'string' ? params.name.trim() : '';
            if (!name) {
              return textResultWithError('skill action=view requires a non-empty name.', true);
            }

            const startedAt = Date.now();
            const payload = buildSkillViewPayload(runtime, name);
            if (!payload) {
              return textResultWithError(`Skill "${name}" not found`, true);
            }
            let telemetryWarning: string | null = null;
            try {
              runtime.recordSkillInvocation(name, {
                outcome: 'success',
                durationMs: Date.now() - startedAt,
              });
            } catch (error) {
              telemetryWarning = `Skill usage telemetry was not recorded: ${toErrorMessage(error)}`;
            }
            return textResult(JSON.stringify({
              ...payload,
              ...(telemetryWarning ? { telemetryWarning } : {}),
            }, null, 2));
          }
          case 'stats':
            return textResult(JSON.stringify(buildSkillStatsPayload(runtime, params.name), null, 2));
          case 'create': {
            const name = typeof params.name === 'string' ? params.name : '';
            const category = typeof params.category === 'string' ? params.category : '';
            const content = typeof params.content === 'string' ? params.content : '';
            if (!name.trim()) {
              return textResultWithError('skill action=create requires a non-empty name.', true);
            }
            if (!category.trim()) {
              return textResultWithError('skill action=create requires a non-empty category.', true);
            }
            if (!content.trim()) {
              return textResultWithError('skill action=create requires non-empty content.', true);
            }

            const screened = await screenSkillWrite('create', {
              content,
              ...(params.description !== undefined
                ? { description: params.description }
                : {}),
            }, intake);
            if (!screened.allowed) {
              return textResult(INTAKE_FIREWALL_NOTICE_TEMPLATES.sinkHeld);
            }

            const reason = normalizeReason(params.reason);
            const decision = resolveSkillWriteGovernanceDecision(governance, 'create', false);
            if (decision.kind === 'refuse') {
              return textResultWithError(decision.message, true);
            }
            if (decision.kind === 'queue') {
              const entry = enqueueSkillWriteProposal(runtime, decision.queue, {
                kind: 'create',
                scope: `${name.trim()} (new)`,
                params: {
                  name,
                  category,
                  content: screened.content,
                  ...(screened.description !== undefined
                    ? { description: screened.description }
                    : {}),
                  ...(reason ? { reason } : {}),
                },
                companionReason: reason ?? `Skill create proposed by ${decision.tier} tier`,
              });
              return queuedSkillWriteResult('create', name.trim(), entry, decision.cause);
            }

            const created = runtime.getStore().create({
              name,
              category,
              ...(screened.description !== undefined
                ? { description: screened.description }
                : {}),
              content: screened.content,
            }, { updatedBy: 'agent', ...(reason ? { reason } : {}) });
            runtime.invalidate();

            return textResult(JSON.stringify({
              action: 'created',
              name: created.name,
              category: created.category,
              version: created.version,
              createdAt: created.createdAt,
              updatedAt: created.updatedAt,
              ownership: 'personal',
              path: created.relativePath,
            }, null, 2));
          }
          case 'update': {
            const name = typeof params.name === 'string' ? params.name : '';
            const content = typeof params.content === 'string' ? params.content : '';
            if (!name.trim()) {
              return textResultWithError('skill action=update requires a non-empty name.', true);
            }
            if (!content.trim()) {
              return textResultWithError('skill action=update requires non-empty content.', true);
            }

            const screened = await screenSkillWrite('update', {
              content,
              ...(params.description !== undefined
                ? { description: params.description }
                : {}),
            }, intake);
            if (!screened.allowed) {
              return textResult(INTAKE_FIREWALL_NOTICE_TEMPLATES.sinkHeld);
            }

            const existing = runtime.getStore().getByName(name);
            if (!existing) {
              return textResultWithError(`Skill "${name.trim()}" does not exist`, true);
            }

            const reason = normalizeReason(params.reason);
            const destructiveRisk = detectDestructiveSkillContentReplace(
              existing.content,
              screened.content,
            );
            const decision = resolveSkillWriteGovernanceDecision(
              governance,
              'update',
              destructiveRisk !== null,
            );
            if (decision.kind === 'refuse') {
              return textResultWithError(decision.message, true);
            }
            if (decision.kind === 'queue') {
              const destructiveNote = destructiveRisk
                ? ` Destructive replace: ${destructiveRisk.previousLength}->${destructiveRisk.nextLength} chars.`
                : '';
              const entry = enqueueSkillWriteProposal(runtime, decision.queue, {
                kind: 'update',
                scope: `${existing.name} (v${existing.version})`,
                params: {
                  name: existing.name,
                  content: screened.content,
                  ...(screened.description !== undefined
                    ? { description: screened.description }
                    : {}),
                  ...(reason ? { reason } : {}),
                  baseVersion: existing.version,
                },
                companionReason:
                  `${reason ?? `Skill update proposed by ${decision.tier} tier`}${destructiveNote}`,
              });
              return queuedSkillWriteResult('update', existing.name, entry, decision.cause);
            }

            const updated = runtime.getStore().update({
              name,
              ...(screened.description !== undefined
                ? { description: screened.description }
                : {}),
              content: screened.content,
            }, { updatedBy: 'agent', ...(reason ? { reason } : {}) });
            runtime.invalidate();

            return textResult(JSON.stringify({
              action: 'updated',
              name: updated.name,
              category: updated.category,
              version: updated.version,
              createdAt: updated.createdAt,
              updatedAt: updated.updatedAt,
              ownership: 'personal',
              path: updated.relativePath,
            }, null, 2));
          }
          case 'history': {
            const name = typeof params.name === 'string' ? params.name.trim() : '';
            if (!name) {
              return textResultWithError('skill action=history requires a non-empty name.', true);
            }
            const entries = runtime.getStore().getHistory(name);
            const requestedVersion = typeof params.version === 'number' ? params.version : null;
            if (requestedVersion !== null) {
              const entry = entries.find((candidate) => candidate.version === requestedVersion);
              if (!entry) {
                return textResultWithError(
                  `Skill "${name}" has no history entry for version ${requestedVersion}`,
                  true,
                );
              }
              return textResult(JSON.stringify({
                action: 'history',
                name,
                version: requestedVersion,
                entry: {
                  action: entry.action,
                  version: entry.version,
                  timestamp: entry.timestamp,
                  updatedBy: entry.updatedBy,
                  reason: entry.reason ?? null,
                  previousVersion: entry.previousVersion,
                  previousChecksum: entry.previousChecksum,
                  newChecksum: entry.newChecksum,
                  document: entry.newDocument,
                },
              }, null, 2));
            }
            return textResult(JSON.stringify({
              action: 'history',
              name,
              entries: entries.map((entry) => ({
                action: entry.action,
                version: entry.version,
                timestamp: entry.timestamp,
                updatedBy: entry.updatedBy,
                reason: entry.reason ?? null,
                previousVersion: entry.previousVersion,
                previousChecksum: entry.previousChecksum,
                newChecksum: entry.newChecksum,
                previousLength: entry.previousDocument?.length ?? null,
                newLength: entry.newDocument.length,
              })),
            }, null, 2));
          }
          case 'rollback': {
            const name = typeof params.name === 'string' ? params.name.trim() : '';
            if (!name) {
              return textResultWithError('skill action=rollback requires a non-empty name.', true);
            }
            const version = params.version;
            if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
              return textResultWithError('skill action=rollback requires a positive integer version.', true);
            }

            const existing = runtime.getStore().getByName(name);
            if (!existing) {
              return textResultWithError(`Skill "${name}" does not exist`, true);
            }

            const reason = normalizeReason(params.reason);
            const decision = resolveSkillWriteGovernanceDecision(governance, 'rollback', false);
            if (decision.kind === 'refuse') {
              return textResultWithError(decision.message, true);
            }
            if (decision.kind === 'queue') {
              const entry = enqueueSkillWriteProposal(runtime, decision.queue, {
                kind: 'rollback',
                scope: `${existing.name} (v${existing.version})`,
                params: {
                  name: existing.name,
                  version,
                  ...(reason ? { reason } : {}),
                },
                companionReason: reason
                  ?? `Skill rollback to version ${version} proposed by ${decision.tier} tier`,
              });
              return queuedSkillWriteResult('rollback', existing.name, entry, decision.cause);
            }

            const restored = runtime.getStore().rollback(name, version, {
              updatedBy: 'agent:rollback',
              ...(reason ? { reason } : {}),
            });
            runtime.invalidate();

            return textResult(JSON.stringify({
              action: 'rolled_back',
              name: restored.name,
              category: restored.category,
              restoredFromVersion: version,
              version: restored.version,
              updatedAt: restored.updatedAt,
              ownership: 'personal',
              path: restored.relativePath,
            }, null, 2));
          }
        }
      } catch (error) {
        const message = toErrorMessage(error);
        return textResultWithError(`Unable to use skill tool: ${message}`, true);
      }
    },
  };

  // Explicit action-aware capability annotation (parity with peer self-mod
  // tools such as persona_update); delegates to the central skill resolver so
  // the annotation and the unified requirement table cannot drift.
  return withCapabilityRequirement(tool, resolveSkillToolCapabilityRequirement);
}
