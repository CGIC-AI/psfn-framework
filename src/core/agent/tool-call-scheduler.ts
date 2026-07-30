import { validateToolArguments } from '@mariozechner/pi-ai';
import type { AgentMessage, AgentTool, AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@mariozechner/pi-ai';
import type { ScheduledAgentEvent } from './agent-loop-events.js';
import type { ToolCallOutcome } from '../../shared/contracts/runtime.js';
import {
  classifyExecutedToolCallOutcome,
  DUPLICATE_TOOL_CALL_SKIP_RESULT,
  isToolCallErrorOutcome,
  SEQUENTIAL_DEPENDENCY_SKIP_RESULT,
} from '../../shared/contracts/tool-call-outcome.js';
import { isInternalWhisperMessage, isSystemNoteMessage } from './messages.js';
import type { ToolConcurrencyMeta, WirableTool } from './tool-wiring-validator.js';
import {
  isToolValidationFailureError,
  recordToolValidationFailure,
} from '../../shared/diagnostics/runtime-diagnostics.js';
import {
  buildMalformedArgumentsCorrection,
  buildSchemaValidationCorrection,
  buildUnknownToolCorrection,
  isMalformedToolArguments,
  type ToolCallCorrection,
} from './tool-call-correction.js';
import {
  internalToolFailureResult,
  textResultWithError,
} from '../tools/results.js';
const TOOL_CANCELLED_NOTICE =
  '[System notice] This tool operation was cancelled before it completed. No internal diagnostic '
  + 'needs interpreting. You can tell your person the operation did not complete.';

export interface ToolCallSchedulerOptions {
  maxParallelToolCalls: number;
  maxFailuresPerSignature?: number;
  guard?: ToolCallExecutionGuard;
  onTelemetry?: (eventName: string, payload: Record<string, unknown>) => void;
}

export interface ToolCallExecutionGuard {
  inFlightSignatures: Set<string>;
  successfulSignatures: Set<string>;
  failureCountsBySignature: Map<string, number>;
  malformedArgumentFailuresByAction: Map<string, MissingArgumentRequirement[]>;
  /**
   * Tool names that produced a validate-and-reprompt correction earlier in this
   * loop. Used to emit `agent.tools.correction.recovered` telemetry when the
   * model reprompts the same tool with a fixed call that then succeeds, so a
   * retried-then-succeeded call is observable instead of looking like a plain
   * success (psfn-framework-b0yl.3).
   */
  correctedToolNames: Set<string>;
}

export function createToolCallExecutionGuard(): ToolCallExecutionGuard {
  return {
    inFlightSignatures: new Set(),
    successfulSignatures: new Set(),
    failureCountsBySignature: new Map(),
    malformedArgumentFailuresByAction: new Map(),
    correctedToolNames: new Set(),
  };
}

interface ToolCallDescriptor {
  toolCall: ToolCall;
  tool: AgentTool<any> | undefined;
  resolveTool: (toolName: string) => AgentTool<any> | undefined;
  resolveAvailableToolNames: () => string[];
  metadata: ToolConcurrencyMeta;
  metadataIssue?: 'missing' | 'invalid';
}

interface ToolExecutionContext {
  signal?: AbortSignal;
  stream: { push: (event: ScheduledAgentEvent) => void };
}

interface MissingArgumentRequirement {
  label: string;
  alternatives: string[];
  mode?: 'any' | 'all';
}

export interface ToolExecutionResult {
  toolResults: ToolResultMessage[];
  steeringMessages?: AgentMessage[];
  haltRemaining?: boolean;
  haltReasonText?: string;
}

type QueuedMessageSkipReason =
  | 'queued_user_message'
  | 'queued_system_message'
  | 'queued_internal_note'
  | 'queued_message';

interface QueuedMessageAttribution {
  telemetryReason: QueuedMessageSkipReason;
  resultText: string;
}

const normalizedValidationParameters = new WeakMap<object, unknown>();

function normalizeToolParametersForPiAiValidation(parameters: unknown): unknown {
  if (!parameters || typeof parameters !== 'object') return parameters;
  const schema = parameters as object;
  // pi-ai 0.73.1 only applies JSON Schema coercion when TypeBox symbols are absent.
  // Repo tools still use @sinclair/typebox schemas, so strip those symbols on a cached clone.
  if (Object.getOwnPropertySymbols(schema).length === 0) return parameters;
  const cached = normalizedValidationParameters.get(schema);
  if (cached) return cached;
  const normalized = structuredClone(parameters);
  normalizedValidationParameters.set(schema, normalized);
  return normalized;
}

function hasNonStringDiscordFollowUpChannelId(tool: AgentTool<any>, toolCall: ToolCall): boolean {
  if (tool.name !== 'schedule') return false;
  const args: unknown = toolCall.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  return record.action === 'create_follow_up'
    && record.channel_type === 'discord'
    && Object.prototype.hasOwnProperty.call(record, 'channel_id')
    && typeof record.channel_id !== 'string';
}

function normalizeToolForPiAiValidation(tool: AgentTool<any>, toolCall: ToolCall): AgentTool<any> {
  // Discord snowflakes exceed Number.MAX_SAFE_INTEGER. Preserve the original
  // TypeBox string check for this one destination boundary so pi-ai cannot
  // stringify an already precision-damaged JavaScript number.
  if (hasNonStringDiscordFollowUpChannelId(tool, toolCall)) return tool;
  const parameters = normalizeToolParametersForPiAiValidation(tool.parameters);
  return parameters === tool.parameters
    ? tool
    : { ...tool, parameters } as AgentTool<any>;
}

function toolResultDetailsFlagError(result: { details?: unknown } | undefined): boolean {
  const details = result?.details;
  return !!details
    && typeof details === 'object'
    && (details as { isError?: unknown }).isError === true;
}

export async function executeToolCallsWithScheduler(
  tools: AgentTool<any>[] | (() => AgentTool<any>[] | undefined) | undefined,
  assistantMessage: AssistantMessage,
  getSteeringMessages: (() => Promise<AgentMessage[]>) | undefined,
  context: ToolExecutionContext,
  options: ToolCallSchedulerOptions,
): Promise<ToolExecutionResult> {
  const toolCalls = assistantMessage.content.filter((content): content is ToolCall => content.type === 'toolCall');
  const resolveTools = typeof tools === 'function' ? tools : () => tools;
  const resolveTool = (toolName: string) => resolveTools()?.find((entry) => entry.name === toolName);
  const resolveAvailableToolNames = () => (resolveTools() ?? []).map((entry) => entry.name);
  const descriptors = toolCalls.map((toolCall): ToolCallDescriptor => {
    const tool = resolveTool(toolCall.name);
    const resolved = resolveToolConcurrencyMetadata(tool);
    return {
      toolCall,
      tool,
      resolveTool,
      resolveAvailableToolNames,
      metadata: resolved.metadata,
      metadataIssue: resolved.issue,
    };
  });

  const results: ToolResultMessage[] = [];
  let steeringMessages: AgentMessage[] | undefined;

  for (let index = 0; index < descriptors.length;) {
    const batch = collectCompatibleBatch(descriptors, index);
    const remainingCount = descriptors.length - (index + batch.length);
    const parallelLimit = resolveBatchParallelLimit(batch, options.maxParallelToolCalls);
    const mode = batch.length > 1 && parallelLimit > 1 ? 'parallel' : 'sequential';

    if (remainingCount > 0) {
      options.onTelemetry?.('agent.tools.scheduler.queued', {
        queuedCount: remainingCount,
        activeBatchSize: batch.length,
        activeTools: batch.map((entry) => entry.toolCall.name),
      });
    }
    options.onTelemetry?.(
      mode === 'parallel' ? 'agent.tools.scheduler.parallel' : 'agent.tools.scheduler.serialized',
      {
        batchSize: batch.length,
        parallelLimit,
        toolNames: batch.map((entry) => entry.toolCall.name),
      },
    );

    options.onTelemetry?.('agent.tools.scheduler.batch', {
      mode,
      batchSize: batch.length,
      parallelLimit,
      queuedRemaining: remainingCount,
      toolNames: batch.map((entry) => entry.toolCall.name),
      classes: batch.map((entry) => entry.metadata.class),
      missingMetadataCount: batch.filter((entry) => entry.metadataIssue === 'missing').length,
      invalidMetadataCount: batch.filter((entry) => entry.metadataIssue === 'invalid').length,
    });

    const batchResults = mode === 'parallel'
      ? await executeParallelBatch(batch, parallelLimit, context, options)
      : await executeSequentialBatch(batch, context, getSteeringMessages, options);

    results.push(...batchResults.toolResults);
    steeringMessages = batchResults.steeringMessages;
    index += batch.length;

    if (batchResults.haltRemaining) {
      const remainingDescriptors = descriptors.slice(index);
      if (remainingDescriptors.length > 0) {
        const resultText = batchResults.haltReasonText
          ?? SEQUENTIAL_DEPENDENCY_SKIP_RESULT;
        options.onTelemetry?.('agent.tools.scheduler.skipped', {
          reason: 'prior_tool_error',
          skippedCount: remainingDescriptors.length,
          skippedTools: remainingDescriptors.map((entry: ToolCallDescriptor) => entry.toolCall.name),
        });
        for (const descriptor of remainingDescriptors) {
          results.push(skipToolCall(
            descriptor.toolCall,
            context.stream,
            resultText,
            'dependency_skip',
          ));
        }
      }
      break;
    }

    if (steeringMessages && steeringMessages.length > 0) {
      const remainingDescriptors = descriptors.slice(index);
      const attribution = resolveQueuedMessageAttribution(steeringMessages);
      options.onTelemetry?.('agent.tools.scheduler.skipped', {
        reason: attribution.telemetryReason,
        skippedCount: remainingDescriptors.length,
        skippedTools: remainingDescriptors.map((entry: ToolCallDescriptor) => entry.toolCall.name),
      });
      for (const descriptor of remainingDescriptors) {
        results.push(skipToolCall(
          descriptor.toolCall,
          context.stream,
          attribution.resultText,
          'dependency_skip',
        ));
      }
      break;
    }
  }

  return {
    toolResults: results,
    steeringMessages,
  };
}

async function executeSequentialBatch(
  descriptors: ToolCallDescriptor[],
  context: ToolExecutionContext,
  getSteeringMessages: (() => Promise<AgentMessage[]>) | undefined,
  options: ToolCallSchedulerOptions,
): Promise<ToolExecutionResult> {
  const results: ToolResultMessage[] = [];
  for (const descriptor of descriptors) {
    const result = await executeSingleToolCall(descriptor, context, options);
    results.push(result);
    if (result.isError) {
      return {
        toolResults: results,
        haltRemaining: true,
        haltReasonText: SEQUENTIAL_DEPENDENCY_SKIP_RESULT,
      };
    }

    if (getSteeringMessages) {
      const steeringMessages = await getSteeringMessages();
      if (steeringMessages.length > 0) {
        return {
          toolResults: results,
          steeringMessages,
        };
      }
    }
  }

  return { toolResults: results };
}

async function executeParallelBatch(
  descriptors: ToolCallDescriptor[],
  parallelLimit: number,
  context: ToolExecutionContext,
  options: ToolCallSchedulerOptions,
): Promise<ToolExecutionResult> {
  const results = await mapBounded(
    descriptors,
    parallelLimit,
    async (descriptor) => executeSingleToolCall(descriptor, context, options),
  );

  return {
    toolResults: results,
  };
}

async function executeSingleToolCall(
  descriptor: ToolCallDescriptor,
  context: ToolExecutionContext,
  options: ToolCallSchedulerOptions,
): Promise<ToolResultMessage> {
  const { toolCall } = descriptor;
  const tool = descriptor.resolveTool(toolCall.name) ?? descriptor.tool;
  const guard = options.guard;
  const signature = buildToolCallSignature(toolCall);
  const maxFailures = Number.isFinite(options.maxFailuresPerSignature)
    ? Math.max(1, Math.floor(options.maxFailuresPerSignature as number))
    : 2;
  if (guard) {
    const repeatedMalformed = resolveRepeatedMalformedArgumentSkip(toolCall, guard);
    if (repeatedMalformed) {
      options.onTelemetry?.('agent.tools.scheduler.skipped', {
        reason: 'repeated_malformed_arguments',
        toolName: toolCall.name,
        action: repeatedMalformed.action,
        missingRequirement: repeatedMalformed.missingRequirement,
      });
      return skipToolCall(
        toolCall,
        context.stream,
        `Internal tool status: skipped repeated malformed ${toolCall.name}${repeatedMalformed.action ? ` action=${repeatedMalformed.action}` : ''} call because required field(s) are still missing: ${repeatedMalformed.missingRequirement}. Use one minimal valid JSON call with all required fields before retrying. This is not a user-facing message.`,
        'validation_rejection',
      );
    }
    if (guard.inFlightSignatures.has(signature)) {
      options.onTelemetry?.('agent.tools.scheduler.skipped', {
        reason: 'duplicate_in_flight',
        toolName: toolCall.name,
      });
      return skipToolCall(
        toolCall,
        context.stream,
        'Internal tool status: skipped duplicate tool call because the same tool/action/input is already in flight. This is not a user-facing message.',
        'duplicate_skip',
      );
    }
    if (guard.successfulSignatures.has(signature)) {
      options.onTelemetry?.('agent.tools.scheduler.skipped', {
        reason: 'duplicate_completed',
        toolName: toolCall.name,
      });
      return skipToolCall(
        toolCall,
        context.stream,
        DUPLICATE_TOOL_CALL_SKIP_RESULT,
        'duplicate_skip',
      );
    }
    const failures = guard.failureCountsBySignature.get(signature) ?? 0;
    if (failures >= maxFailures) {
      options.onTelemetry?.('agent.tools.scheduler.skipped', {
        reason: 'tool_signature_degraded',
        toolName: toolCall.name,
        failures,
      });
      return skipToolCall(
        toolCall,
        context.stream,
        `Internal tool status: ${toolCall.name} is degraded for this action/input after ${failures} failed attempts this turn. Stop retrying it for now and notify the operator if it affects the conversation. This is not a user-facing message.`,
        'dependency_skip',
      );
    }
    guard.inFlightSignatures.add(signature);
  }

  context.stream.push({
    type: 'tool_execution_start',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });

  let result: AgentToolResult<unknown> | undefined;
  let isError = false;
  let outcome: ToolCallOutcome = 'success';
  let cancelled = false;
  // Validate-and-reprompt (psfn-framework-b0yl.3): a recoverable tool-call
  // defect (unknown/retired name, malformed non-object arguments, or
  // schema-invalid arguments) becomes a corrective tool result fed back to the
  // model, never a dropped turn or a silently defaulted action.
  let correction: ToolCallCorrection | undefined;
  try {
    if (!tool) {
      correction = buildUnknownToolCorrection(
        toolCall.name,
        descriptor.resolveAvailableToolNames(),
      );
    } else if (isMalformedToolArguments(toolCall.arguments)) {
      correction = buildMalformedArgumentsCorrection(toolCall.name, toolCall.arguments);
    } else {
      const validatedArgs = validateToolArguments(
        normalizeToolForPiAiValidation(tool, toolCall),
        toolCall,
      );
      result = await tool.execute(toolCall.id, validatedArgs, context.signal, (partialResult) => {
        context.stream.push({
          type: 'tool_execution_update',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,
          partialResult,
        });
      });
      outcome = classifyExecutedToolCallOutcome({
        details: result.details,
        isError: toolResultDetailsFlagError(result),
      });
      isError = isToolCallErrorOutcome(outcome);
    }
  } catch (error) {
    if (isToolValidationFailureError(error)) {
      correction = buildSchemaValidationCorrection(
        toolCall.name,
        error instanceof Error ? error.message : String(error),
      );
    } else {
      cancelled = context.signal?.aborted === true
        || (error instanceof Error && /abort(ed)?/i.test(error.message));
      if (!cancelled) {
        options.onTelemetry?.('agent.tools.execution.failed', {
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { errorStack: error.stack } : {}),
        });
      }
      result = cancelled
        ? textResultWithError(TOOL_CANCELLED_NOTICE, true, {
            errorClass: 'unavailable',
            retryHint: 'do_not_retry',
            companionMessage: TOOL_CANCELLED_NOTICE,
          })
        : internalToolFailureResult();
      isError = true;
      outcome = 'execution_failure';
    }
  }

  if (correction) {
    recordToolValidationFailure({
      toolName: toolCall.name,
      reason: `${correction.defectClass}: ${correction.text}`,
    });
    options.onTelemetry?.('agent.tools.validation.failed', {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      defectClass: correction.defectClass,
    });
    options.onTelemetry?.('agent.tools.correction.reprompt', {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      defectClass: correction.defectClass,
      ...(correction.suggestion ? { suggestedTool: correction.suggestion } : {}),
    });
    guard?.correctedToolNames.add(toolCall.name);
    result = {
      content: [{ type: 'text', text: correction.text }],
      details: {},
    };
    isError = true;
    outcome = 'validation_rejection';
  }

  if (!result) {
    // Fail closed: every branch above assigns a result. A missing result here
    // is a runtime invariant break, not a droppable turn.
    throw new Error(`Tool call for ${toolCall.name} produced no result`);
  }

  if (cancelled) {
    options.onTelemetry?.('agent.tools.scheduler.cancelled', {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
    });
  }

  if (guard) {
    guard.inFlightSignatures.delete(signature);
    if (isError) {
      guard.failureCountsBySignature.set(
        signature,
        (guard.failureCountsBySignature.get(signature) ?? 0) + 1,
      );
      recordMalformedArgumentFailure(guard, toolCall, result);
    } else {
      guard.successfulSignatures.add(signature);
      if (guard.correctedToolNames.delete(toolCall.name)) {
        options.onTelemetry?.('agent.tools.correction.recovered', {
          toolName: toolCall.name,
          toolCallId: toolCall.id,
        });
      }
    }
  }

  context.stream.push({
    type: 'tool_execution_end',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError,
    outcome,
  });

  const toolResultMessage: ToolResultMessage & { outcome: ToolCallOutcome } = {
    role: 'toolResult',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: result.details,
    isError,
    outcome,
    timestamp: Date.now(),
  };
  context.stream.push({ type: 'message_start', message: toolResultMessage });
  context.stream.push({ type: 'message_end', message: toolResultMessage });
  return toolResultMessage;
}

function skipToolCall(
  toolCall: ToolCall,
  stream: { push: (event: ScheduledAgentEvent) => void },
  reasonText: string,
  outcome: Extract<ToolCallOutcome, 'validation_rejection' | 'duplicate_skip' | 'dependency_skip'>,
): ToolResultMessage {
  const result = {
    content: [{ type: 'text' as const, text: reasonText }],
    details: {} as Record<string, unknown>,
  };
  stream.push({
    type: 'tool_execution_start',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });
  stream.push({
    type: 'tool_execution_end',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError: true,
    outcome,
  });

  const toolResultMessage: ToolResultMessage & { outcome: ToolCallOutcome } = {
    role: 'toolResult',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: {},
    isError: true,
    outcome,
    timestamp: Date.now(),
  };
  stream.push({ type: 'message_start', message: toolResultMessage });
  stream.push({ type: 'message_end', message: toolResultMessage });
  return toolResultMessage;
}

function buildToolCallSignature(toolCall: ToolCall): string {
  return `${String(toolCall.name)}:${stableStringify(toolCall.arguments)}`;
}

function resolveToolCallAction(toolCall: ToolCall): string {
  const args: unknown = toolCall.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const action = (args as Record<string, unknown>).action;
  return typeof action === 'string' ? action.trim() : '';
}

function buildMalformedActionKey(toolCall: ToolCall): string {
  return `${String(toolCall.name)}:${resolveToolCallAction(toolCall)}`;
}

function hasUsefulArgumentValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null;
}

function satisfiesRequirement(toolCall: ToolCall, requirement: MissingArgumentRequirement): boolean {
  const args: unknown = toolCall.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  const checker = (field: string) => hasUsefulArgumentValue(record[field]);
  return requirement.mode === 'all'
    ? requirement.alternatives.every(checker)
    : requirement.alternatives.some(checker);
}

function missingRequirementLabel(toolCall: ToolCall, requirement: MissingArgumentRequirement): string {
  if (requirement.mode !== 'all') return requirement.label;
  const args: unknown = toolCall.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return requirement.label;
  const record = args as Record<string, unknown>;
  const missing = requirement.alternatives.filter(field => !hasUsefulArgumentValue(record[field]));
  return missing.length > 0 ? missing.join(', ') : requirement.label;
}

function resolveRepeatedMalformedArgumentSkip(
  toolCall: ToolCall,
  guard: ToolCallExecutionGuard,
): { action: string; requirement: MissingArgumentRequirement; missingRequirement: string } | null {
  const requirements = guard.malformedArgumentFailuresByAction.get(buildMalformedActionKey(toolCall));
  if (!requirements || requirements.length === 0) return null;
  for (const requirement of requirements) {
    if (!satisfiesRequirement(toolCall, requirement)) {
      return {
        action: resolveToolCallAction(toolCall),
        requirement,
        missingRequirement: missingRequirementLabel(toolCall, requirement),
      };
    }
  }
  return null;
}

function normalizeRequiredFieldLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseMissingArgumentRequirement(text: string): MissingArgumentRequirement | null {
  const normalized = normalizeRequiredFieldLabel(text);
  const typeboxMatch = /(?:^|[-\s])(?:[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?\s*:\s*)?must have required properties?\s+([a-z][a-z0-9_]*(?:\s*,\s*[a-z][a-z0-9_]*)*)/iu.exec(normalized);
  if (typeboxMatch?.[1]) {
    const alternatives = typeboxMatch[1]
      .split(/\s*,\s*/u)
      .map(field => field.trim())
      .filter(Boolean);
    if (alternatives.length > 0) {
      return {
        label: alternatives.join(', '),
        alternatives,
        mode: 'all',
      };
    }
  }

  const match = /(?:^|[.:\s])([a-z][a-z0-9_]*(?:\s+or\s+[a-z][a-z0-9_]*)*)\s+is\s+required(?:[.\s]|$)/iu.exec(normalized);
  if (!match?.[1]) return null;
  const alternatives = match[1]
    .split(/\s+or\s+/iu)
    .map(field => field.trim())
    .filter(Boolean);
  if (alternatives.length === 0) return null;
  return {
    label: alternatives.join(' or '),
    alternatives,
  };
}

function toolResultText(result: { content?: unknown[] }): string {
  return (result.content ?? [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const text = (entry as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function recordMalformedArgumentFailure(
  guard: ToolCallExecutionGuard,
  toolCall: ToolCall,
  result: { content?: unknown[] },
): void {
  const requirement = parseMissingArgumentRequirement(toolResultText(result));
  if (!requirement) return;
  const key = buildMalformedActionKey(toolCall);
  const existing = guard.malformedArgumentFailuresByAction.get(key) ?? [];
  if (existing.some(entry => entry.label === requirement.label)) return;
  guard.malformedArgumentFailuresByAction.set(key, [...existing, requirement]);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}

function resolveQueuedMessageAttribution(messages: readonly AgentMessage[]): QueuedMessageAttribution {
  if (messages.some(message => (message as { role?: string }).role === 'user')) {
    return {
      telemetryReason: 'queued_user_message',
      resultText: 'Skipped due to queued user message.',
    };
  }
  if (messages.some(isSystemNoteMessage)) {
    return {
      telemetryReason: 'queued_system_message',
      resultText: 'Skipped due to queued system message.',
    };
  }
  if (messages.some(isInternalWhisperMessage)) {
    return {
      telemetryReason: 'queued_internal_note',
      resultText: 'Skipped due to queued internal note.',
    };
  }
  return {
    telemetryReason: 'queued_message',
    resultText: 'Skipped due to queued message.',
  };
}

function collectCompatibleBatch(descriptors: ToolCallDescriptor[], startIndex: number): ToolCallDescriptor[] {
  const first = descriptors[startIndex];
  if (first.metadata.class === 'exclusive') {
    return [first];
  }

  const batch: ToolCallDescriptor[] = [first];
  for (let index = startIndex + 1; index < descriptors.length; index += 1) {
    const candidate = descriptors[index];
    if (
      batch.some((entry) => !canRunConcurrently(entry, candidate))
    ) {
      break;
    }
    batch.push(candidate);
  }
  return batch;
}

function canRunConcurrently(a: ToolCallDescriptor, b: ToolCallDescriptor): boolean {
  if (a.metadataIssue || b.metadataIssue) {
    return false;
  }
  if (a.metadata.class !== b.metadata.class) {
    return false;
  }
  if (a.metadata.class !== 'spawn_subagent') {
    return false;
  }
  if (
    a.metadata.exclusivityKeyPolicy !== 'none'
    || b.metadata.exclusivityKeyPolicy !== 'none'
    || a.metadata.exclusivityKey !== undefined
    || b.metadata.exclusivityKey !== undefined
  ) {
    return false;
  }
  return true;
}

function resolveBatchParallelLimit(batch: ToolCallDescriptor[], maxParallelToolCalls: number): number {
  const boundedGlobal = Number.isFinite(maxParallelToolCalls)
    ? Math.max(1, Math.floor(maxParallelToolCalls))
    : 1;
  const boundedByMetadata = batch.reduce((current, descriptor) => {
    const candidate = descriptor.metadata.maxParallel;
    if (!candidate || !Number.isInteger(candidate) || candidate < 1) {
      return current;
    }
    return Math.min(current, Math.floor(candidate));
  }, boundedGlobal);
  return Math.max(1, Math.min(boundedGlobal, boundedByMetadata));
}

async function mapBounded<TInput, TOutput>(
  items: readonly TInput[],
  concurrencyLimit: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const limit = Math.max(1, Math.floor(concurrencyLimit));
  const results: TOutput[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const currentIndex = nextIndex;
      if (currentIndex >= items.length) {
        return;
      }
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as TInput, currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

function resolveToolConcurrencyMetadata(
  tool: AgentTool<any> | undefined,
): { metadata: ToolConcurrencyMeta; issue?: 'missing' | 'invalid' } {
  if (!tool) {
    return {
      metadata: createFailClosedConcurrencyMetadata('tool'),
      issue: 'missing',
    };
  }

  const concurrency = (tool as WirableTool).wiringMeta?.concurrency as Partial<ToolConcurrencyMeta> | undefined;
  if (!concurrency) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'missing',
    };
  }
  if (
    concurrency.class !== 'exclusive'
    && concurrency.class !== 'read_only'
    && concurrency.class !== 'spawn_subagent'
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.exclusivityKeyPolicy !== 'none'
    && concurrency.exclusivityKeyPolicy !== 'category_tool_name'
    && concurrency.exclusivityKeyPolicy !== 'static_key'
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.class === 'exclusive'
    && (!concurrency.exclusivityKey || concurrency.exclusivityKey.trim().length === 0)
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.class === 'exclusive'
    && concurrency.exclusivityKeyPolicy === 'none'
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.class !== 'exclusive'
    && concurrency.exclusivityKeyPolicy !== 'none'
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.class !== 'exclusive'
    && concurrency.exclusivityKey !== undefined
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.maxParallel !== undefined
    && (!Number.isInteger(concurrency.maxParallel) || concurrency.maxParallel < 1)
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    concurrency.interruptibility !== 'cooperative'
    && concurrency.interruptibility !== 'non_interruptible'
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  if (
    !concurrency.eligibility
    || typeof concurrency.eligibility.foreground !== 'boolean'
    || typeof concurrency.eligibility.background !== 'boolean'
    || (!concurrency.eligibility.foreground && !concurrency.eligibility.background)
  ) {
    return {
      metadata: createFailClosedConcurrencyMetadata(`tool:${tool.name}`),
      issue: 'invalid',
    };
  }

  return {
    metadata: {
      class: concurrency.class,
      exclusivityKeyPolicy: concurrency.exclusivityKeyPolicy,
      ...(concurrency.exclusivityKey !== undefined ? { exclusivityKey: concurrency.exclusivityKey } : {}),
      ...(concurrency.maxParallel !== undefined ? { maxParallel: concurrency.maxParallel } : {}),
      interruptibility: concurrency.interruptibility,
      eligibility: { ...concurrency.eligibility },
    },
  };
}

function createFailClosedConcurrencyMetadata(exclusivityKey: string): ToolConcurrencyMeta {
  return {
    class: 'exclusive',
    exclusivityKeyPolicy: 'static_key',
    exclusivityKey,
    interruptibility: 'cooperative',
    eligibility: {
      foreground: true,
      background: true,
    },
  };
}
