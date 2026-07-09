// ── Substrate Agent Tool Contract ──
// pi-agent-core 0.73 types `AgentTool.execute` parameters via typebox v1
// `Static<TParameters>`, which resolves to `unknown` for `AgentTool<any>` and
// cannot infer from this repo's @sinclair/typebox schema values when the
// generic is erased. PSFN's tool-call scheduler validates every tool call's
// arguments against the tool's JSON schema (`validateToolArguments`) before
// `execute` is invoked, so tool implementations receive schema-validated
// arguments and keep their concrete parameter typings.
//
// `SubstrateAgentTool` is the repo-owned tool definition type that preserves
// that validated-params contract. It is mutually assignable with
// `AgentTool<any>` so tools flow unchanged into pi-agent-core APIs
// (`AgentState.tools`, the scheduler loop, wiring validators).

import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';

export type SubstrateAgentTool<TDetails = any> = Omit<AgentTool<any, TDetails>, 'execute'> & {
  /**
   * Execute the tool call. `params` has been validated against `parameters`
   * by the tool-call scheduler before invocation; implementations annotate
   * the concrete validated shape.
   */
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
};
