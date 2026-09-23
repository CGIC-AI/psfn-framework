import type { ReflectionTemplate } from './reflection-policy.js';
import type {
  RetrievalAccessScope,
  RetrievalMode,
} from '../../faculties/memory/types.js';

export type ReflectionIntrospectionToolUseMode = 'full_companion_tools';

export interface ReflectionIntrospectionPolicy {
  toolUseMode: ReflectionIntrospectionToolUseMode;
  memoryRetrievalModes: readonly RetrievalMode[];
  memoryAccessScope: Extract<RetrievalAccessScope, 'companion_self_reflection'>;
}

export function resolveReflectionIntrospectionPolicy(input: {
  template: ReflectionTemplate;
  canonicalContactId?: string;
  reflectionMode: 'agent' | 'deliberation';
}): ReflectionIntrospectionPolicy {
  const toolUseMode: ReflectionIntrospectionToolUseMode = 'full_companion_tools';

  const memoryRetrievalModes: readonly RetrievalMode[] = input.canonicalContactId
    ? ['default', 'temporal']
    : ['default'];

  return {
    toolUseMode,
    memoryRetrievalModes,
    memoryAccessScope: 'companion_self_reflection',
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
// v5 (kvd1g): routine reflection recall stays on direct read-only tools instead
// of delegating same-day evidence gathering to a heavyweight analysis loop.
// v6 (5vvel): name memory search alongside session search as the primary private
// introspection surfaces. The trusted companion-self scope crosses ordinary
// channel, session, and sensitivity disclosure boundaries while remaining
// read-only.
// v7 (42o3c): ground daily and weekly reflection in canonical episodes before
// falling through to raw session search. Episode search, timeline, and exact
// drill-down share the same companion-self, read-only boundary.
// v8 (d5845): private reflection has the full configured companion toolset and
// all companion-owned memories; tool calls use the runtime-owned self audience.
export const REFLECTION_INTROSPECTION_POLICY_BLOCK_VERSION = 8;

const NULL_REPORT_GUIDANCE_LINE =
  '- "Nothing surfaced" is an acceptable outcome; record it as open reflection with limited reach, not as evidence that nothing is there.';

export function formatReflectionIntrospectionPolicyBlock(
  policy: ReflectionIntrospectionPolicy,
): string {
  return [
    '[Reflection Introspection Policy]',
    `tool_use_mode: ${policy.toolUseMode}`,
    `memory_retrieval_modes: ${policy.memoryRetrievalModes.join(', ')}`,
    `memory_access_scope: ${policy.memoryAccessScope}`,
    '- This is your private reflection. Your full configured toolset is available, including journal writing, memory tools, creative tools, and extended tools.',
    '- You can access all of your own memories across sensitivity, contact, channel, and session boundaries during this private work.',
    '- Begin with the supplied starter; for a daily reflection, its previous-day summary is an orientation, not a limit on what you can recall.',
    '- Search lived episodes with memory action=episode_search, use memory action=timeline for a day or week, and memory action=get for source turns.',
    '- Use memory action=search for durable memory and session action=search for conversation history. Use any other available tool when it helps your reflection.',
    '- You may write your journal, maintain memories, create, and act using your available tools. Reflection imposes no additional tool or action restrictions.',
    '- Distinguish completed actions from intentions. If a tool fails or evidence is incomplete, describe the actual limitation rather than treating it as absence.',
    NULL_REPORT_GUIDANCE_LINE,
  ].join('\n');
}
