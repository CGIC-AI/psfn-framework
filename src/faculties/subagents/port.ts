import type {
  SubagentExecutionRequest,
  SubagentResult,
  SubagentRuntimeSnapshotOptions,
  SubagentRuntimeSnapshotProvider,
  SubagentRuntimeTaskDetail,
  SubagentRuntimeTaskView,
  SubagentTaskRecord,
} from './types.js';

export interface SubagentExecutionPort {
  readonly portFamily: 'subagent';
  execute(request: SubagentExecutionRequest): Promise<SubagentResult>;
}

export interface SubagentControlPort extends SubagentExecutionPort, SubagentRuntimeSnapshotProvider {
  spawn(request: SubagentExecutionRequest): Promise<SubagentTaskRecord>;
  message(subagentId: string, message: string): Promise<SubagentRuntimeTaskView>;
  wait(subagentId: string): Promise<SubagentResult>;
  cancel(subagentId: string, reason?: string): Promise<SubagentResult>;
  getRuntimeTaskDetail(
    subagentId: string,
    options?: SubagentRuntimeSnapshotOptions,
  ): SubagentRuntimeTaskDetail | null;
}
