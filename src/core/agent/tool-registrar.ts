import type { AgentTool } from '../../boundary/pi-agent/index.js';

export type ToolCategory = 'core' | 'extended';

export type ToolRegistrar = (
  tool: AgentTool<any>,
  category?: ToolCategory,
) => void;

export interface ToolRegistrarTarget {
  registerTool: ToolRegistrar;
}
