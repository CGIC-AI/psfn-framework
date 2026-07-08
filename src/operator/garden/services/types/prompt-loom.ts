import type {
  ContextMessage,
  LLMProviderWireMessage,
  LLMSystemPromptTransport,
  PromptSectionTelemetry,
  ToolSchema,
  TurnRecord,
} from '../../../../shared/contracts/runtime.js';
import type { PromptPlan } from '../../../../core/agent/substrate-agent/turn-execution/prompt-plan.js';
import type {
  ObservedMemory,
  ObservedScoredMemory,
  TurnMemorySnapshotRecord,
  TurnRetrievalTelemetryRecord,
  TurnSessionContextSnapshotRecord,
  TurnSnapshotRecord,
  TurnStageTelemetryRecord,
} from '../../../../core/turns/observability.js';

export type AdminObservedMemory = ObservedMemory;

export type AdminObservedScoredMemory = ObservedScoredMemory;

export type AdminTurnStageTelemetry = TurnStageTelemetryRecord;

export type AdminTurnRetrievalTelemetry = TurnRetrievalTelemetryRecord;

export type AdminTurnSessionContextSnapshotData = TurnSessionContextSnapshotRecord;

export type AdminTurnMemorySnapshotData = TurnMemorySnapshotRecord;

export type AdminTurnSnapshotData = TurnSnapshotRecord;

export interface AdminPromptLoomHistoricalSnapshotHit {
  layerId: string;
  source: string;
  sectionId?: string;
  title?: string;
}

export interface AdminPromptLoomHistoricalSnapshotData {
  label: string;
  removedPromptLayerIds: string[];
  hits: AdminPromptLoomHistoricalSnapshotHit[];
}

export interface AdminPromptLoomGeneratedPromptData {
  renderedStaticPrefix: string | null;
  renderedDynamicSuffix: string | null;
  runtimeContext: string | null;
  memoryContextBlock: string | null;
  scratchpadContext: string | null;
  assembledPrompt: string | null;
  contextMessages: ContextMessage[];
  inputSections: PromptSectionTelemetry[];
  runtimeContextSections: PromptSectionTelemetry[];
  memoryContextSections: PromptSectionTelemetry[];
  finalSystemSections: PromptSectionTelemetry[];
}

export interface AdminPromptLoomProviderPayloadData {
  finalSystemPrompt: string | null;
  providerMessages: LLMProviderWireMessage[];
  activeTools: ToolSchema[];
}

export interface AdminPromptLoomProviderResultData {
  response: NonNullable<TurnSnapshotRecord['promptContext']>['response'] | null;
  renderedChatOutput: string | null;
}

export interface AdminPromptLoomMemoryCaptureData {
  input: {
    currentTurnInput: string | null;
    userMessage?: TurnRecord['userMessage'];
    assistantMessage?: TurnRecord['assistantMessage'];
    renderedChatOutput: string | null;
  };
  output: {
    extractedMemoryIds: string[];
  };
}

export interface AdminPromptLoomToolActivityData {
  toolCalls: TurnRecord['toolCalls'];
  toolResults: TurnRecord['toolCalls'];
}

/**
 * The Loom's Provider Wire projection (E2.3): the serialized provider payload
 * (system prompt + messages + tool definitions) exactly as shipped.
 *
 * - source 'prompt_plan': derived from the persisted PromptPlan via
 *   serializePromptPlanForProvider — byte-equal to the wire by construction.
 * - source 'recorded_snapshot': the recorded provider-wire capture. Used for
 *   legacy pre-plan records (legacy=true) and, fail-open-never, when a plan
 *   exists but the system-role transport was not recorded (legacy=false, so
 *   the degradation is visible rather than silent).
 */
export interface AdminPromptLoomProviderWireData {
  source: 'prompt_plan' | 'recorded_snapshot';
  /** true when the turn predates the PromptPlan snapshot ("legacy turn (pre-plan)"). */
  legacy: boolean;
  systemRoleTransport: LLMSystemPromptTransport | null;
  systemPrompt: string | null;
  messages: LLMProviderWireMessage[];
  /** Tool definitions exactly as shipped to the provider for this turn. */
  toolDefinitions: ToolSchema[];
}

export interface AdminPromptLoomData {
  source: 'turn_snapshot';
  snapshotCapturedAt: number | null;
  /**
   * The persisted, schema-versioned PromptPlan the Loom projects (E2.3).
   * null for legacy records that predate the plan snapshot.
   */
  plan: PromptPlan | null;
  providerWire: AdminPromptLoomProviderWireData;
  historicalSnapshot: AdminPromptLoomHistoricalSnapshotData;
  generatedPrompt: AdminPromptLoomGeneratedPromptData;
  providerPayload: AdminPromptLoomProviderPayloadData;
  providerResult: AdminPromptLoomProviderResultData;
  memoryCapture: AdminPromptLoomMemoryCaptureData;
  toolActivity: AdminPromptLoomToolActivityData;
}
