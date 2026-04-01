import type { SubagentExecutionRequest, SubagentResult } from './types.js';

export interface SubagentExecutionPort {
  readonly portFamily: 'subagent';
  execute(request: SubagentExecutionRequest): Promise<SubagentResult>;
}
