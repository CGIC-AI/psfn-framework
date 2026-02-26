import type { AgentTool } from '@mariozechner/pi-agent-core';
import { SkillsRuntime, type SkillsRuntimeOptions } from './runtime.js';
import {
  createSkillCreateTool,
  createSkillListTool,
  createSkillUpdateTool,
  createSkillViewTool,
} from './tools.js';

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
  target.registerTool(createSkillViewTool(runtime));
  target.registerTool(createSkillCreateTool(runtime));
  target.registerTool(createSkillUpdateTool(runtime));
  return runtime;
}
