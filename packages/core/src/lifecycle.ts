/**
 * `@cgic/psfn-core/lifecycle` entrypoint: stream transport, explicit tool contract
 * helpers, request context, turn records, memory-deletion approval ports, and
 * host-executed automata ingress APIs.
 */
export type { SubstrateStreamTransport } from '../../../src/core/agent/stream-adapter.js';
export type { LLMProviderStreamOptions } from '../../../src/core/agent/contracts.js';
export type {
  AgentResponse,
  LLMContext,
  LLMResponse,
  StreamCallbacks,
  SubstrateMessage,
  ToolCall,
} from '../../../src/shared/contracts/runtime-base.js';
export type { TurnRecord } from '../../../src/shared/contracts/runtime.js';
export { NonRecoverableFallbackError } from '../../../src/primitives/llm/fallback.js';
export { resolveExplicitToolContract } from '../../../src/primitives/llm/explicit-tool-request.js';
export { buildExactToolArgumentsModelSchema } from '../../../src/primitives/llm/explicit-tool-arguments.js';
export { createTurnId } from '../../../src/core/turns/id.js';
export { externalMemorySessionId } from '../../../src/shared/contracts/external-memory.js';
export { getRequestContext, runWithRequestContext } from '../../../src/primitives/llm/request-context.js';
export { AUTOMATA_BUS_TOOL_ACTIONS } from '../../../src/faculties/automata/bus/worker-access-contracts.js';
export { automataBusToolParametersForActions } from '../../../src/faculties/automata/bus/worker-access-operation.js';
export type {
  MemoryDeletionApprovalPort,
  MemoryDeletionApprovalRequest,
  MemoryDeletionApprovalResult,
  MemoryDeletionProposalStorePort,
} from '../../../src/faculties/memory/deletion-proposals.js';
export {
  HostedAutomataExecutor,
  type HostedAttemptClaim,
  type HostedAttemptRefusal,
  type HostedAttemptReport,
  type HostedAttemptStatus,
  type HostedAutomataEvent,
  type HostedAutomataPolicy,
  type HostedReportAnswer,
  type HostedResult,
} from '../../../src/faculties/subagents/host-execution.js';
