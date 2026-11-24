import type { ToolRegistrar } from '../../core/agent/tool-registrar.js';
import type {
  ReflectionNudgePort,
  SkillsRuntimePromptPort,
} from '../../shared/contracts/skills-runtime-port.js';
import { ReflectionNudgeTracker } from './reflection-nudge.js';
import { SkillsRuntime, type SkillsRuntimeOptions } from './runtime.js';
import {
  createSkillTool,
  type SkillWriteGovernance,
  type SkillWriteIntakeRuntime,
} from './tools.js';

export interface SkillsRuntimeTarget {
  skillsRuntime: SkillsRuntimePromptPort | null;
  reflectionNudge?: ReflectionNudgePort | null;
  registerTool: ToolRegistrar;
}

export function wireSkillsRuntime(
  target: SkillsRuntimeTarget,
  options: SkillsRuntimeOptions,
  governance: SkillWriteGovernance,
  intake?: SkillWriteIntakeRuntime,
): SkillsRuntime {
  const runtime = new SkillsRuntime(options);
  target.skillsRuntime = runtime;
  target.reflectionNudge = new ReflectionNudgeTracker({
    resolveAdmittedSkills: () => runtime.getCachedAdmittedSkills(),
    resolveConfig: () => runtime.getCachedReuseConfig(),
    resolveOutcomeEvidence: () => runtime.getSkillOutcomeEvidence(),
    recordPostUseOutcome: (input) => {
      runtime.recordSkillPostUseOutcome(input);
    },
  });
  target.registerTool(createSkillTool(runtime, intake, governance), 'core');
  return runtime;
}
