import type { AgentTool } from '@mariozechner/pi-agent-core';
import { SkillsRuntime, type SkillsRuntimeOptions } from './runtime.js';
import { createSkillListTool } from './tools.js';

export interface SkillsRuntimeTarget {
  skillsRuntime: SkillsRuntime | null;
  registerTool(tool: AgentTool<any>, category?: 'core' | 'extended'): void;
}

export function wireSkillsRuntime(
  target: SkillsRuntimeTarget,
  options: SkillsRuntimeOptions,
): SkillsRuntime {
  const runtime = new SkillsRuntime(options);
  target.skillsRuntime = runtime;
  target.registerTool(createSkillListTool(runtime));
  return runtime;
}
