import type { AgentTool } from '@mariozechner/pi-agent-core';

export type ToolCategory = 'core' | 'extended';

export type ToolRegistrar = (
  tool: AgentTool<any>,
  category?: ToolCategory,
) => void;

export interface ToolRegistrarTarget {
  registerTool: ToolRegistrar;
}
