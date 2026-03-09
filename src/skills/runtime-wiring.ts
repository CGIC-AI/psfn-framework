import type { ToolRegistrar } from '../agent/tool-registrar.js';
import { SkillsRuntime, type SkillsRuntimeOptions } from './runtime.js';
import {
  createSkillCreateTool,
  createSkillListTool,
  createSkillUpdateTool,
  createSkillViewTool,
} from './tools.js';

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
  target.registerTool(createSkillListTool(runtime));
  target.registerTool(createSkillViewTool(runtime));
  target.registerTool(createSkillCreateTool(runtime), 'extended');
  target.registerTool(createSkillUpdateTool(runtime), 'extended');
  return runtime;
}
