import type { ToolRegistrar } from '../agent/tool-registrar.js';
import { SkillsRuntime, type SkillsRuntimeOptions } from './runtime.js';
import { createSkillTool } from './tools.js';

export interface SkillsRuntimeTarget {
  skillsRuntime: SkillsRuntime | null;
  registerTool: ToolRegistrar;
}

export function wireSkillsRuntime(
  target: SkillsRuntimeTarget,
  options: SkillsRuntimeOptions,
): SkillsRuntime {
  const runtime = new SkillsRuntime(options);
  target.skillsRuntime = runtime;
  target.registerTool(createSkillTool(runtime), 'core');
  return runtime;
}
