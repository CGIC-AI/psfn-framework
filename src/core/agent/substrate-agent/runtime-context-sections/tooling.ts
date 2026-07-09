// ── Tooling section producers (E2.6) ──
// The tool-count/capability variable group, the extended-tool guide, and the
// extended-tool directory variables. Tool state (loaded/promoted/turn class)
// is passed in as declared inputs; nothing here reads the runtime.

import type { AgentTool } from '../../../../boundary/pi-agent/index.js';
import type { CapabilityTier } from '../../../../system/config/runtime-config-contracts.js';
import { resolveTierCapabilityTokens } from '../../../../system/capabilities/tiers.js';
import { resolveToolRequiredCapabilities } from '../../../../system/capabilities/requirements.js';
import type { CapabilityToken } from '../../../../system/capabilities/tokens.js';
import type { AdaptiveLoadedExtendedToolState } from '../../adaptive-tools-telemetry.js';
import type { ExtendedToolTurnClass } from '../../extended-tool-autoload-policy.js';

export interface RuntimeContextActiveToolCounts {
  core: number;
  promoted: number;
  extendedLoaded: number;
  autoload: number;
  deferred: number;
  total: number;
}

interface ExtendedToolGuideEntry {
  line: string;
  blocked: boolean;
  activatable: boolean;
}

export interface ExtendedToolGuide {
  lines: string[];
  activatableCount: number;
  blockedCount: number;
}

export function buildExtendedToolGuide(input: {
  capabilityTier: CapabilityTier;
  extendedTools: AgentTool<any>[];
  loadedExtended: Map<string, AdaptiveLoadedExtendedToolState>;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  promotedExtendedToolNames: Set<string>;
}): ExtendedToolGuide {
  const grantedTokens = new Set<CapabilityToken>(resolveTierCapabilityTokens(input.capabilityTier));
  const entries: ExtendedToolGuideEntry[] = input.extendedTools.map((tool) => {
    const loaded = input.loadedExtended.get(tool.name);
    const turnClass = input.classifyExtendedToolForTurn(tool.name);

    if (turnClass !== 'overlay') {
      return {
        line: `- ${tool.name}: ${tool.description.split('.')[0]} (background-only; not callable in-turn)`,
        blocked: false,
        activatable: false,
      };
    }

    const missingTokens = resolveToolRequiredCapabilities(tool, {})
      .filter(token => !grantedTokens.has(token));
    const blockedSuffix = missingTokens.length > 0
      ? `; current tier blocks execution: ${missingTokens.join(', ')}`
      : '';

    let suffix = '(use toolset action="activate")';
    let activatable = true;
    if (input.promotedExtendedToolNames.has(tool.name)) {
      suffix = `(promoted, always active${blockedSuffix})`;
      activatable = false;
    } else if (loaded?.source === 'autoload') {
      suffix = `(autoload active${blockedSuffix})`;
      activatable = false;
    } else if (loaded?.source === 'deferred') {
      suffix = `(deferred active${blockedSuffix})`;
      activatable = false;
    } else if (loaded?.source === 'extended_loaded') {
      suffix = `(loaded active${blockedSuffix})`;
      activatable = false;
    } else if (missingTokens.length > 0) {
      suffix = `(blocked by current tier: ${missingTokens.join(', ')})`;
      activatable = false;
    }

    return {
      line: `- ${tool.name}: ${tool.description.split('.')[0]} ${suffix}`.replace(/\s+\(/, ' ('),
      blocked: missingTokens.length > 0,
      activatable,
    };
  });

  return {
    lines: entries.map(entry => entry.line),
    activatableCount: entries.filter(entry => entry.activatable).length,
    blockedCount: entries.filter(entry => entry.blocked).length,
  };
}

export function buildToolingPromptVariables(input: {
  capabilityTier: CapabilityTier;
  analysisWorkbenchAvailable: boolean;
  activeToolCounts: RuntimeContextActiveToolCounts;
  availableExtendedCount: number;
}): Record<string, string> {
  const {
    core: coreCount,
    promoted: promotedCount,
    extendedLoaded: extendedLoadedCount,
    autoload: autoloadCount,
    deferred: deferredCount,
    total: activeCount,
  } = input.activeToolCounts;
  return {
    runtime_capability_tier: input.capabilityTier,
    runtime_analysis_workbench_available: String(input.analysisWorkbenchAvailable),
    runtime_tooling_active_count: String(activeCount),
    runtime_tooling_core_count: String(coreCount),
    runtime_tooling_promoted_count: String(promotedCount),
    runtime_tooling_loaded_count: String(extendedLoadedCount),
    runtime_tooling_autoload_count: String(autoloadCount),
    runtime_tooling_deferred_count: String(deferredCount),
    runtime_tooling_available_extended_count: String(input.availableExtendedCount),
  };
}

export function buildExtendedToolPromptVariables(input: {
  extendedTools: AgentTool<any>[];
  extendedToolGuide: ExtendedToolGuide;
}): Record<string, string> {
  return {
    runtime_extended_tools_total: String(input.extendedTools.length),
    runtime_extended_tools_activatable_count: String(input.extendedToolGuide.activatableCount),
    runtime_extended_tools_blocked_count: String(input.extendedToolGuide.blockedCount),
    runtime_extended_tool_names: input.extendedTools.map(tool => tool.name).join(', '),
    runtime_extended_tool_directory_lines: input.extendedToolGuide.lines.join('\n'),
  };
}
