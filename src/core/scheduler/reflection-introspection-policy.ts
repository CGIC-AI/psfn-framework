import type { ReflectionTemplate } from './heartbeat-policy.js';
import type { RetrievalMode } from '../../faculties/memory/types.js';

export type ReflectionIntrospectionToolUseMode =
  | 'prompt_bounded'
  | 'bounded_read_only_introspection';

export interface ReflectionIntrospectionPolicy {
  toolUseMode: ReflectionIntrospectionToolUseMode;
  memoryRetrievalModes: readonly RetrievalMode[];
  thinkHelpers: readonly string[];
  allowOverlayToolActivation: false;
}

export function resolveReflectionIntrospectionPolicy(input: {
  template: ReflectionTemplate;
  canonicalContactId?: string;
  reflectionMode: 'agent' | 'deliberation';
}): ReflectionIntrospectionPolicy {
  const toolUseMode: ReflectionIntrospectionToolUseMode = input.reflectionMode === 'agent'
    ? 'bounded_read_only_introspection'
    : 'prompt_bounded';

  const memoryRetrievalModes: readonly RetrievalMode[] = input.canonicalContactId
    ? ['temporal', 'reflection']
    : ['reflection'];

  return {
    toolUseMode,
    memoryRetrievalModes,
    thinkHelpers: toolUseMode === 'bounded_read_only_introspection'
      ? ['memory_search', 'session_messages', 'session_search']
      : [],
    allowOverlayToolActivation: false,
  };
}

export function formatReflectionIntrospectionPolicyBlock(
  policy: ReflectionIntrospectionPolicy,
): string {
  const lines = [
    '[Reflection Introspection Policy]',
    `tool_use_mode: ${policy.toolUseMode}`,
    `memory_retrieval_modes: ${policy.memoryRetrievalModes.join(', ')}`,
    'overlay_tool_activation: forbidden',
  ];

  if (policy.toolUseMode === 'bounded_read_only_introspection') {
    lines.push(
      '- This is a maintenance reflection turn, not a foreground user turn.',
      '- If deeper synthesis is necessary, you may use the core analysis_workbench tool.',
      `- Inside analysis_workbench, restrict evidence gathering to read-only introspection helpers: ${policy.thinkHelpers.join(', ')}.`,
      '- Do not call tool_search or toolset, and do not activate overlay or extended tools.',
      '- Do not call mutating, runtime-management, scheduling, repo-write, or external-communication tools.',
      '- If evidence is incomplete, say so explicitly and stay within the provided context.',
    );
    return lines.join('\n');
  }

  lines.push(
    '- This reflection run is prompt-bounded and must not make tool calls.',
    '- Rely only on the provided reflection context and the retrieved memory block.',
    '- If evidence is incomplete, say so explicitly instead of escalating privileges or inventing support.',
  );
  return lines.join('\n');
}
