import type { ToolRegistrar } from '../../core/agent/tool-registrar.js';
import { SkillsRuntime, type SkillsRuntimeOptions } from './runtime.js';
import {
  createSkillTool,
  type SkillWriteIntakeRuntime,
} from './tools.js';

export interface SkillsRuntimeTarget {
  skillsRuntime: SkillsRuntime | null;
  registerTool: ToolRegistrar;
}

export function wireSkillsRuntime(
  target: SkillsRuntimeTarget,
  options: SkillsRuntimeOptions,
  intake?: SkillWriteIntakeRuntime,
): SkillsRuntime {
  const runtime = new SkillsRuntime(options);
  target.skillsRuntime = runtime;
  target.registerTool(createSkillTool(runtime, intake), 'core');
  return runtime;
}
