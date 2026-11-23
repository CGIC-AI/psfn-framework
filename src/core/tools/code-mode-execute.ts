// ── Primary-Turn Hybrid Code Mode Execute Tool (b3h5p.4) ──
// Exposes a direct `execute({ code, timeout_ms? })` REPL tool backed by the
// hardened child-process sandbox execution port. Gated canonical AgentTools
// are projected onto a frozen `sdk` namespace (`await sdk.<tool>(args)`) while
// preserving AsyncLocalStorage request/turn context, CogSec intake screening
// on every inner tool result, and disclosure lineage updates. Permit-bound
// external egress tools remain direct structured wire tools and are never
// exposed inside arbitrary JS execution.

import { validateToolArguments, type ToolCall } from '@earendil-works/pi-ai';
import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult, SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import { withChildProcessSandboxExecutionPort } from '../../boundary/sandbox/sandbox-execution-port.js';
import type {
  SandboxExecutionPortSeed,
  SandboxHostHelper,
} from '../../shared/contracts/sandbox-analysis-contracts.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { isRecord } from '../../shared/utils/types.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../agent/tool-surface/descriptions.js';
import type { ToolResultIntakeScreener } from '../agent/tool-call-scheduler.js';
import { DEFAULT_REPL_CONFIG } from './analysis-workbench/types.js';

/**
 * High-authority / permit-bound egress and turn-disposition tools that must
 * remain direct structured wire tools for exact gateway permit inspection and
 * scheduler semantics rather than being invoked inside raw JS scripts.
 */
const CODE_MODE_DIRECT_WIRE_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'notify',
  'mcp',
  'publication',
  'response_control',
]);

/**
 * Meta-tools excluded from the inner `sdk` namespace to prevent recursive VM
 * nesting or redundant control calls inside scripts.
 */
const CODE_MODE_META_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'execute',
  'tool_search',
  'toolset',
]);

/**
 * Minimal upfront wire toolset advertised to the LLM provider when Hybrid Code
 * Mode (`execute`) is active on a turn: progressive discovery (`tool_search`),
 * the sandboxed SDK REPL (`execute`), and the direct permit-bound egress /
 * turn-disposition tools (`notify`, `mcp`, `publication`, `response_control`).
 */
export const HYBRID_CODE_MODE_DIRECT_WIRE_TOOLS: ReadonlySet<string> = new Set([
  'tool_search',
  'execute',
  ...CODE_MODE_DIRECT_WIRE_ONLY_TOOLS,
]);

const VALID_JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const NON_TEXT_INNER_RESULT_WITHHELD_NOTICE =
  '[System notice] Non-text tool content was withheld because no intake screener admitted it.';
const DEFAULT_EXECUTE_TIMEOUT_MS = DEFAULT_REPL_CONFIG.tierBudgets.nursery.maxWallTimeMs;
const MAX_EXECUTE_TIMEOUT_MS = DEFAULT_REPL_CONFIG.tierBudgets.apprentice.maxWallTimeMs;
const MIN_EXECUTE_TIMEOUT_MS = Math.floor(DEFAULT_REPL_CONFIG.executionTimeoutMs / 50);
const DEFAULT_EXECUTE_MEMORY_CEILING_BYTES =
  DEFAULT_REPL_CONFIG.tierBudgets.autonomous.memoryCeilingMb * 1024 * 1024;
const MAX_EXECUTE_OUTPUT_CHARS = DEFAULT_REPL_CONFIG.outputTruncation * 4;
const MAX_INNER_SDK_CALLS = DEFAULT_REPL_CONFIG.budget.maxToolCalls ?? 50;

const normalizedValidationParameters = new WeakMap<object, unknown>();

export function isCodeModeSdkCallableTool(toolName: string): boolean {
  const normalized = toolName.trim();
  if (!normalized || !VALID_JS_IDENTIFIER.test(normalized)) return false;
  return !CODE_MODE_DIRECT_WIRE_ONLY_TOOLS.has(normalized)
    && !CODE_MODE_META_EXCLUDED_TOOLS.has(normalized);
}

interface CodeModeInnerToolCallSummary {
  tool: string;
  ok: boolean;
  withheld?: boolean;
}

interface CodeModeExecuteToolDetails {
  isError?: boolean;
  durationMs: number;
  innerCalls: CodeModeInnerToolCallSummary[];
  withheldCount: number;
  truncated?: boolean;
}

export interface CodeModeExecuteToolRuntime {
  /** Returns the current turn's live gated AgentTool instances. */
  getCallableTools: () => readonly AgentTool<any>[];
  /** Optional CogSec intake screener shared with the parent tool scheduler. */
  toolResultScreener?: ToolResultIntakeScreener;
  /** Optional disclosure lineage hook shared with the parent tool scheduler. */
  onToolResultAdmitted?: (input: { toolName: string; arguments: unknown }) => void;
  /** Optional telemetry emitter. */
  onTelemetry?: (eventName: string, payload: Record<string, unknown>) => void;
  /** Optional sandbox execution port override (defaults to child-process sandbox). */
  executionPort?: SandboxExecutionPortSeed | null;
}

function normalizeParametersForValidation(parameters: unknown): unknown {
  if (!parameters || typeof parameters !== 'object') return parameters;
  const schema = parameters as object;
  if (Object.getOwnPropertySymbols(schema).length === 0) return parameters;
  const cached = normalizedValidationParameters.get(schema);
  if (cached) return cached;
  const normalized = structuredClone(parameters);
  normalizedValidationParameters.set(schema, normalized);
  return normalized;
}

function hasNonStringDiscordFollowUpChannelId(toolName: string, args: Record<string, unknown>): boolean {
  return toolName === 'schedule'
    && args.action === 'create_follow_up'
    && args.channel_type === 'discord'
    && Object.prototype.hasOwnProperty.call(args, 'channel_id')
    && typeof args.channel_id !== 'string';
}

function extractResultText(result: AgentToolResult<unknown>): string {
  if (!Array.isArray(result.content)) return '';
  return result.content
    .filter((block): block is { type: 'text'; text: string } => (
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
    ))
    .map(block => block.text)
    .join('\n');
}

function hasNonTextResultContent(result: AgentToolResult<unknown>): boolean {
  return Array.isArray(result.content)
    && result.content.some(block => !isRecord(block) || block.type !== 'text');
}

function resultIndicatesError(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  if (isRecord(details) && details.isError === true) return true;
  if (isRecord(result) && (result as { isError?: unknown }).isError === true) return true;
  return false;
}

function parseInnerReturnValue(text: string, isError: boolean): unknown {
  const trimmed = text.trim();
  if (!isError && trimmed.length > 0 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  if (isError) {
    return { isError: true, text };
  }
  return text;
}

function truncateExecuteOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_EXECUTE_OUTPUT_CHARS) {
    return { text, truncated: false };
  }
  const omitted = text.length - MAX_EXECUTE_OUTPUT_CHARS;
  return {
    text: `${text.slice(0, MAX_EXECUTE_OUTPUT_CHARS)}\n...[truncated ${omitted} chars]`,
    truncated: true,
  };
}

function clampTimeoutMs(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return DEFAULT_EXECUTE_TIMEOUT_MS;
  }
  return Math.max(MIN_EXECUTE_TIMEOUT_MS, Math.min(MAX_EXECUTE_TIMEOUT_MS, Math.floor(requested)));
}

function wrapAsyncExecuteCode(code: string): string {
  return `(async () => {\nconst __psfnExecuteReturnValue = await (async () => {\n${code}\n})();\nif (__psfnExecuteReturnValue !== undefined) {\n  FINAL(typeof __psfnExecuteReturnValue === 'string' ? __psfnExecuteReturnValue : JSON.stringify(__psfnExecuteReturnValue, null, 2));\n}\n})()`;
}

export function createCodeModeExecuteTool(
  runtime: CodeModeExecuteToolRuntime,
): SubstrateAgentTool {
  const executionPort = withChildProcessSandboxExecutionPort(runtime.executionPort ?? null);

  return {
    name: 'execute',
    label: 'execute',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.execute,
    parameters: Type.Object({
      code: Type.String({
        description: 'JavaScript async code body executed inside the isolated sandbox VM. Call gated companion tools via `await sdk.<tool>(args)`. Return a value or use `print(...)` / `FINAL(...)`.',
      }),
      timeout_ms: Type.Optional(Type.Integer({
        description: `Optional execution timeout in milliseconds (default ${DEFAULT_EXECUTE_TIMEOUT_MS}, max ${MAX_EXECUTE_TIMEOUT_MS}).`,
        minimum: MIN_EXECUTE_TIMEOUT_MS,
        maximum: MAX_EXECUTE_TIMEOUT_MS,
      })),
    }),
    execute: async (
      toolCallId: string,
      rawParams: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<CodeModeExecuteToolDetails>> => {
      const startedAt = Date.now();
      const params = isRecord(rawParams) ? rawParams : {};
      const code = typeof params.code === 'string' ? params.code : '';
      if (code.trim().length === 0) {
        return {
          content: [{ type: 'text', text: 'execute requires a non-empty JavaScript code string.' }],
          details: {
            isError: true,
            durationMs: Date.now() - startedAt,
            innerCalls: [],
            withheldCount: 0,
          },
        };
      }

      const timeoutMs = clampTimeoutMs(params.timeout_ms);
      const callableTools = runtime.getCallableTools()
        .filter(tool => isCodeModeSdkCallableTool(tool.name));
      const hostHelpers: Record<string, SandboxHostHelper> = {};
      const innerCalls: CodeModeInnerToolCallSummary[] = [];
      let withheldCount = 0;
      let innerCallSeq = 0;

      for (const tool of callableTools) {
        const helperKey = `sdk.${tool.name}`;
        hostHelpers[helperKey] = async (rawToolArgs?: unknown): Promise<unknown> => {
          if (signal?.aborted) {
            throw new Error(`execute cancelled before invoking sdk.${tool.name}`);
          }
          innerCallSeq += 1;
          if (innerCallSeq > MAX_INNER_SDK_CALLS) {
            throw new Error(
              `execute exceeded inner SDK call limit (${MAX_INNER_SDK_CALLS}) while calling sdk.${tool.name}`,
            );
          }

          let normalizedArgs: Record<string, unknown>;
          if (rawToolArgs === undefined) {
            normalizedArgs = {};
          } else if (isRecord(rawToolArgs)) {
            normalizedArgs = rawToolArgs;
          } else {
            throw new Error(`sdk.${tool.name} expects an arguments object.`);
          }

          const innerCallId = `${toolCallId}:sdk:${innerCallSeq}:${tool.name}`;
          const validationTool = hasNonStringDiscordFollowUpChannelId(tool.name, normalizedArgs)
            ? tool
            : { ...tool, parameters: normalizeParametersForValidation(tool.parameters) };
          const toolCall: ToolCall = {
            type: 'toolCall',
            id: innerCallId,
            name: tool.name,
            arguments: normalizedArgs,
          };

          let validatedArgs: Record<string, unknown>;
          try {
            validatedArgs = validateToolArguments(validationTool, toolCall) as Record<string, unknown>;
          } catch (validationError) {
            innerCalls.push({ tool: tool.name, ok: false });
            throw new Error(
              `Invalid arguments for sdk.${tool.name}: ${toErrorMessage(validationError)}`,
            );
          }

          const result = await tool.execute(innerCallId, validatedArgs, signal);
          const rawText = extractResultText(result);
          const hasResultContent = Array.isArray(result.content) && result.content.length > 0;
          const hasNonText = hasNonTextResultContent(result);
          const hasOnlyNonText = hasNonText && rawText.trim().length === 0;
          let deliveredText = rawText;
          let isError = resultIndicatesError(result);
          let withheld = false;

          if (runtime.toolResultScreener && hasResultContent) {
            try {
              const screened = runtime.toolResultScreener({
                toolName: tool.name,
                toolCallId: innerCallId,
                arguments: validatedArgs,
                text: rawText,
              });
              if (screened && screened.mode === 'enforce') {
                const contentWithheld = screened.withheld || hasNonText;
                const effectiveText = hasOnlyNonText
                  ? NON_TEXT_INNER_RESULT_WITHHELD_NOTICE
                  : screened.effectiveText;
                if (effectiveText !== rawText || hasNonText) {
                  runtime.onTelemetry?.('agent.tools.intake.screened', {
                    toolName: tool.name,
                    toolCallId: innerCallId,
                    withheld: contentWithheld,
                    envelopeState: screened.snapshot.state,
                    viaCodeModeExecute: true,
                  });
                  deliveredText = effectiveText;
                  withheld = contentWithheld;
                }
              }
            } catch (screeningError) {
              // Fail closed: never expose unscreened content or screener error text
              // (which could quote hostile bytes) back into the VM.
              runtime.onTelemetry?.('agent.tools.intake.screen_failed', {
                toolName: tool.name,
                toolCallId: innerCallId,
                error: toErrorMessage(screeningError),
                viaCodeModeExecute: true,
              });
              withheldCount += 1;
              innerCalls.push({ tool: tool.name, ok: false, withheld: true });
              return {
                isError: true,
                withheld: true,
                text: `Internal tool status: the ${tool.name} result was withheld because intake screening failed.`,
              };
            }
          }

          runtime.onToolResultAdmitted?.({
            toolName: tool.name,
            arguments: validatedArgs,
          });

          if (withheld) {
            withheldCount += 1;
            innerCalls.push({ tool: tool.name, ok: false, withheld: true });
            return {
              isError: true,
              withheld: true,
              text: deliveredText,
            };
          }

          innerCalls.push({ tool: tool.name, ok: !isError });
          return parseInnerReturnValue(deliveredText, isError);
        };
      }

      const helperNames = Object.keys(hostHelpers);
      const response = await executionPort.executeCode({
        code: wrapAsyncExecuteCode(code),
        timeoutMs,
        memoryCeilingBytes: DEFAULT_EXECUTE_MEMORY_CEILING_BYTES,
        initialLocals: {},
        helperNames,
        hostHelpers,
      });

      const durationMs = Date.now() - startedAt;
      const sections: string[] = [];
      if (response.output.length > 0) {
        sections.push(response.output.join('\n'));
      }
      if (response.finalAnswer !== null) {
        sections.push(response.finalAnswer);
      }
      if (response.error !== null) {
        sections.push(`Error: ${response.error}`);
      }

      const combinedRaw = sections.length > 0
        ? sections.join('\n\n')
        : '(completed with no return value or printed output)';
      const { text: finalText, truncated } = truncateExecuteOutput(combinedRaw);
      const isError = response.error !== null;
      const details: CodeModeExecuteToolDetails = {
        ...(isError ? { isError: true } : {}),
        durationMs,
        innerCalls,
        withheldCount,
        ...(truncated ? { truncated: true } : {}),
      };

      return {
        content: [{ type: 'text', text: finalText }],
        details,
      };
    },
  };
}
