import type { AgentTool } from '@mariozechner/pi-agent-core';
import { resolveToolRequiredCapabilities } from '../../system/capabilities/requirements.js';
import { getToolReversibility, type ToolReversibility } from '../../system/capabilities/safeguards.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  getCanonicalToolSurface,
  type CanonicalToolExposure,
  type FirstPartyToolDomain,
} from './tool-surface/registry.js';
import type { ToolWiringMeta } from './tool-wiring-validator.js';

export type RuntimeToolScope = 'core' | 'extended';

const TOOLSET_CONTROL_TOOL_NAMES = ['tool_search', 'toolset'] as const;

export function isToolsetControlToolName(name: string): boolean {
  return TOOLSET_CONTROL_TOOL_NAMES.includes(name as typeof TOOLSET_CONTROL_TOOL_NAMES[number]);
}

export interface RuntimeToolCatalogEntry {
  name: string;
  description: string;
  scope: RuntimeToolScope;
  wiringMeta?: ToolWiringMeta;
  schema?: RuntimeToolSchemaDescription;
}

export interface RuntimeToolActionDescription {
  name: string;
  requiredCapabilities: CapabilityToken[];
}

export interface RuntimeToolSchemaDescription {
  actions: RuntimeToolActionDescription[];
  requiredParameters: string[];
  requiredCapabilities: CapabilityToken[];
  reversibility: ToolReversibility;
  interruptibility?: NonNullable<ToolWiringMeta['concurrency']>['interruptibility'];
  concurrency?: ToolWiringMeta['concurrency'];
  bundleMembership: string[];
  canonical?: {
    domain: FirstPartyToolDomain;
    exposure: CanonicalToolExposure;
  };
}

export interface RuntimeToolCatalogSnapshot {
  generatedAt: number;
  tools: RuntimeToolCatalogEntry[];
}

type SchemaLike = Record<string, unknown>;

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].map(value => value.trim()).filter(Boolean))];
}

function extractStringLiterals(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  const literals: string[] = [];
  if (typeof schema.const === 'string') literals.push(schema.const);
  if (Array.isArray(schema.enum)) {
    for (const value of schema.enum) {
      if (typeof value === 'string') literals.push(value);
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const entries = schema[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      literals.push(...extractStringLiterals(entry));
    }
  }
  return uniqueStrings(literals);
}

function extractActionNames(parameters: unknown): string[] {
  if (!isRecord(parameters)) return [];
  const properties = parameters.properties;
  if (!isRecord(properties)) return [];
  return extractStringLiterals(properties.action);
}

export function extractRequiredParameterNames(parameters: unknown): string[] {
  if (!isRecord(parameters)) return [];
  const required = (parameters as SchemaLike).required;
  if (!Array.isArray(required)) return [];
  return uniqueStrings(required.filter((value): value is string => typeof value === 'string'));
}

function cloneConcurrencyMeta(
  concurrency: ToolWiringMeta['concurrency'] | undefined,
): ToolWiringMeta['concurrency'] | undefined {
  if (!concurrency) return undefined;
  return {
    ...concurrency,
    eligibility: { ...concurrency.eligibility },
  };
}

function resolveActionDescriptions(tool: AgentTool<any>): RuntimeToolActionDescription[] {
  const canonical = getCanonicalToolSurface(tool.name);
  const actionNames = uniqueStrings(canonical?.actions ?? extractActionNames(tool.parameters));
  return actionNames.map(action => ({
    name: action,
    requiredCapabilities: resolveToolRequiredCapabilities(tool, { action }),
  }));
}

function resolveBundleMembership(
  toolName: string,
  scope: RuntimeToolScope,
): string[] {
  const bundles: string[] = [scope];
  if (isToolsetControlToolName(toolName)) {
    bundles.push('toolset.control');
  } else if (scope === 'extended') {
    bundles.push('toolset.managed');
  }
  const canonical = getCanonicalToolSurface(toolName);
  if (canonical) {
    bundles.push(`domain:${canonical.domain}`, `exposure:${canonical.exposure}`);
  }
  return uniqueStrings(bundles);
}

function buildRuntimeToolSchemaDescription(
  tool: AgentTool<any>,
  scope: RuntimeToolScope,
): RuntimeToolSchemaDescription {
  const wiringMeta = (tool as AgentTool<any> & { wiringMeta?: ToolWiringMeta }).wiringMeta;
  const concurrency = cloneConcurrencyMeta(wiringMeta?.concurrency);
  const canonical = getCanonicalToolSurface(tool.name);
  return {
    actions: resolveActionDescriptions(tool),
    requiredParameters: extractRequiredParameterNames(tool.parameters),
    requiredCapabilities: resolveToolRequiredCapabilities(tool, {}),
    reversibility: getToolReversibility(tool),
    ...(concurrency?.interruptibility ? { interruptibility: concurrency.interruptibility } : {}),
    ...(concurrency ? { concurrency } : {}),
    bundleMembership: resolveBundleMembership(tool.name, scope),
    ...(canonical
      ? {
        canonical: {
          domain: canonical.domain,
          exposure: canonical.exposure,
        },
      }
      : {}),
  };
}

export function buildRuntimeToolCatalogEntry(
  tool: AgentTool<any>,
  scope: RuntimeToolScope,
  wiringMeta?: ToolWiringMeta,
): RuntimeToolCatalogEntry {
  return {
    name: tool.name,
    description: tool.description,
    scope,
    ...(wiringMeta ? { wiringMeta } : {}),
    schema: buildRuntimeToolSchemaDescription(tool, scope),
  };
}
