// ── Tooling section producers (E2.6) ──
// The tool-count/capability variable group, the extended-tool guide, and the
// extended-tool directory variables. Nothing here reads the runtime.

import type { AgentTool } from '../../../../boundary/pi-agent/index.js';
import type { CapabilityTier } from '../../../../system/config/runtime-config-contracts.js';
import { resolveTierCapabilityTokens } from '../../../../system/capabilities/tiers.js';
import { resolveToolRequiredCapabilities } from '../../../../system/capabilities/requirements.js';
import type { CapabilityToken } from '../../../../system/capabilities/tokens.js';

export interface RuntimeContextActiveToolCounts {
  core: number;
  extended: number;
  total: number;
}

interface ExtendedToolGuideEntry {
  line: string;
  blocked: boolean;
  callable: boolean;
}

export interface ExtendedToolGuide {
  lines: string[];
  callableCount: number;
  blockedCount: number;
}

export function buildExtendedToolGuide(input: {
  capabilityTier: CapabilityTier;
  extendedTools: AgentTool<any>[];
}): ExtendedToolGuide {
  const grantedTokens = new Set<CapabilityToken>(resolveTierCapabilityTokens(input.capabilityTier));
  const entries: ExtendedToolGuideEntry[] = input.extendedTools.map((tool) => {
    const missingTokens = resolveToolRequiredCapabilities(tool, {})
      .filter(token => !grantedTokens.has(token));
    const suffix = missingTokens.length > 0
      ? `(present but blocked by current tier: ${missingTokens.join(', ')})`
      : '(call directly; no activation step)';

    return {
      line: `- ${tool.name}: ${tool.description.split('.')[0]} ${suffix}`.replace(/\s+\(/, ' ('),
      blocked: missingTokens.length > 0,
      callable: missingTokens.length === 0,
    };
  });

  return {
    lines: entries.map(entry => entry.line),
    callableCount: entries.filter(entry => entry.callable).length,
    blockedCount: entries.filter(entry => entry.blocked).length,
  };
}

export function buildToolingPromptVariables(input: {
  capabilityTier: CapabilityTier;
  analysisWorkbenchAvailable: boolean;
  activeToolCounts: RuntimeContextActiveToolCounts;
  availableExtendedCount: number;
}): Record<string, string> {
  const { core: coreCount, extended: extendedCount, total: activeCount } = input.activeToolCounts;
  return {
    runtime_capability_tier: input.capabilityTier,
    runtime_analysis_workbench_available: String(input.analysisWorkbenchAvailable),
    runtime_tooling_active_count: String(activeCount),
    runtime_tooling_core_count: String(coreCount),
    runtime_tooling_extended_count: String(extendedCount),
    runtime_tooling_registered_extended_count: String(input.availableExtendedCount),
  };
}

export function buildExtendedToolPromptVariables(input: {
  extendedTools: AgentTool<any>[];
  extendedToolGuide: ExtendedToolGuide;
}): Record<string, string> {
  return {
    runtime_extended_tools_total: String(input.extendedTools.length),
    runtime_extended_tools_callable_count: String(input.extendedToolGuide.callableCount),
    runtime_extended_tools_blocked_count: String(input.extendedToolGuide.blockedCount),
    runtime_extended_tool_names: input.extendedTools.map(tool => tool.name).join(', '),
    runtime_extended_tool_directory_lines: input.extendedToolGuide.lines.join('\n'),
  };
}
