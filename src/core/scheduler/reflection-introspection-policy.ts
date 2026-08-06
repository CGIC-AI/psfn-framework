import type { ReflectionTemplate } from './reflection-policy.js';
import type {
  RetrievalAccessScope,
  RetrievalMode,
} from '../../faculties/memory/types.js';

export type ReflectionIntrospectionToolUseMode =
  | 'prompt_bounded'
  | 'bounded_read_only_introspection';

export interface ReflectionIntrospectionPolicy {
  toolUseMode: ReflectionIntrospectionToolUseMode;
  memoryRetrievalModes: readonly RetrievalMode[];
  memoryAccessScope: Extract<RetrievalAccessScope, 'companion_self_reflection'>;
  allowOverlayToolActivation: false;
}

export function resolveReflectionIntrospectionPolicy(input: {
  template: ReflectionTemplate;
  canonicalContactId?: string;
  reflectionMode: 'agent' | 'deliberation';
}): ReflectionIntrospectionPolicy {
  const toolUseMode: ReflectionIntrospectionToolUseMode = 'bounded_read_only_introspection';

  const memoryRetrievalModes: readonly RetrievalMode[] = input.canonicalContactId
    ? ['default', 'temporal']
    : ['default'];

  return {
    toolUseMode,
    memoryRetrievalModes,
    memoryAccessScope: 'companion_self_reflection',
    allowOverlayToolActivation: false,
  };
}

// This block is prepended to every scheduled reflection prompt, so it is part
// of the self-report instrument (R6, docs/self-eval-prompt-audit.md): version
// wording changes instead of editing casually.
// v2: added the R7 null-report line ("nothing surfaced" is an acceptable,
// weak-evidence outcome) to both tool-use modes.
// v3 (jy6s): scheduled private reflections use explicit companion-self memory
// scope, retrieve prior reflection memories again, and give deliberation a
// bounded read-only tool-grounding pass before synthesis.
// v4 (rqn1.3): companion-register wording — "foreground user turn" reads as
// "foreground conversation turn" (charter 6.28/8.12); no semantic change.
// v5 (kvd1g): routine reflection recall stays on the direct, read-only session
// surface instead of delegating same-day evidence gathering to a heavyweight
// analysis loop.
export const REFLECTION_INTROSPECTION_POLICY_BLOCK_VERSION = 5;

const NULL_REPORT_GUIDANCE_LINE =
  '- "Nothing surfaced" is an acceptable outcome; record it as open reflection with limited reach, not as evidence that nothing is there.';

export function formatReflectionIntrospectionPolicyBlock(
  policy: ReflectionIntrospectionPolicy,
): string {
  const lines = [
    '[Reflection Introspection Policy]',
    `tool_use_mode: ${policy.toolUseMode}`,
    `memory_retrieval_modes: ${policy.memoryRetrievalModes.join(', ')}`,
    `memory_access_scope: ${policy.memoryAccessScope}`,
    'overlay_tool_activation: forbidden',
  ];

  if (policy.toolUseMode === 'bounded_read_only_introspection') {
    lines.push(
      '- This is a maintenance reflection turn, not a foreground conversation turn.',
      '- Gather additional evidence with the read-only session tool directly: use list, search, or grep for the relevant conversation window.',
      '- Keep routine recall inside this reflection turn instead of delegating it to another analysis loop.',
      '- Do not call tool_search or toolset, and do not activate overlay or extended tools.',
      '- Do not call mutating, runtime-management, scheduling, repo-write, or external-communication tools.',
      '- If the provided context and direct session recall are incomplete, say so explicitly instead of escalating to a heavier tool.',
      NULL_REPORT_GUIDANCE_LINE,
    );
    return lines.join('\n');
  }

  lines.push(
    '- This reflection run is prompt-bounded and must not make tool calls.',
    '- Rely only on the provided reflection context and the retrieved memory block.',
    '- If evidence is incomplete, say so explicitly instead of escalating privileges or inventing support.',
    NULL_REPORT_GUIDANCE_LINE,
  );
  return lines.join('\n');
}
