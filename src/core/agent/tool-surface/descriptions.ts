/**
 * Deep public interface for canonical model-facing tool descriptions.
 *
 * Action contracts are split by domain under ./descriptions so broad catalog
 * entries and narrowed variants render from one structured source.
 */
import { AGENCY_TOOL_CONTRACTS } from './descriptions/agency-contracts.js';
import { CATALOG_BOUNDARY_TOOL_CONTRACTS } from './descriptions/catalog-boundary-contracts.js';
import { CONTINUITY_TOOL_CONTRACTS } from './descriptions/continuity-contracts.js';
import type {
  CanonicalToolActionContract,
  CanonicalToolSurfaceContract,
} from './descriptions/contracts.js';
import { KNOWLEDGE_TOOL_CONTRACTS } from './descriptions/knowledge-contracts.js';
import { OPERATIONS_TOOL_CONTRACTS } from './descriptions/operations-contracts.js';

export type {
  CanonicalToolActionContract,
  CanonicalToolSurfaceContract,
} from './descriptions/contracts.js';

export const CANONICAL_TOOL_SURFACE_CONTRACTS = {
  ...CATALOG_BOUNDARY_TOOL_CONTRACTS,
  ...CONTINUITY_TOOL_CONTRACTS,
  ...KNOWLEDGE_TOOL_CONTRACTS,
  ...OPERATIONS_TOOL_CONTRACTS,
  ...AGENCY_TOOL_CONTRACTS,
} as const satisfies Record<string, CanonicalToolSurfaceContract>;

export type CanonicalToolSurfaceDescriptionName = keyof typeof CANONICAL_TOOL_SURFACE_CONTRACTS;

interface CanonicalToolSurfaceVariant {
  readonly tool: CanonicalToolSurfaceDescriptionName;
  readonly actionIds: readonly string[];
  readonly purpose: string;
  readonly output: string;
  readonly guidance: string;
  readonly boundary: string;
  readonly example: Readonly<Record<string, unknown>>;
}

const CANONICAL_TOOL_SURFACE_VARIANTS = {
  read_only: {
    tool: 'repo',
    actionIds: ['inspect'],
    purpose: 'Inspect repository status and diffs through the read-only repo projection.',
    output: 'It returns bounded repository status and diff state.',
    guidance: 'Do not use it for ordinary personal files; use fs for those.',
    boundary: 'This projection returns inspection state only and cannot call repository mutation actions.',
    example: { action: 'inspect', target: 'both' },
  },
  companion_candidate: {
    tool: 'notify',
    actionIds: ['send_companion'],
    purpose: 'Initiate the exact permitted companion contact from an authorized ICP candidate turn.',
    output: 'It returns the initiation result and lets the destination turn author peer-visible text.',
    guidance: 'Do not use this projection outside the exact candidate companion initiation.',
    boundary: 'This send-only projection is permit-bound to the exact candidate and rejects message content or any other notification action.',
    example: {
      action: 'send', target_kind: 'companion', contact_id: 'contact-123',
      initiation_permit: '11111111-1111-4111-8111-111111111111',
    },
  },
} as const satisfies Record<string, CanonicalToolSurfaceVariant>;

export type CanonicalToolSurfaceVariantName = keyof typeof CANONICAL_TOOL_SURFACE_VARIANTS;

function formatFields(fields: readonly string[]): string {
  return fields.length === 0 ? 'none' : fields.join(', ');
}

function renderActionContract(contract: CanonicalToolActionContract): string {
  const requiredParts = [
    ...(contract.required.length > 0 ? [contract.required.join(', ')] : []),
    ...(contract.requiredAnyOf ?? []).length > 0
      ? [`one alternative of ${(contract.requiredAnyOf ?? []).map(group => `[${group.join(', ')}]`).join(' or ')}`]
      : [],
    ...(contract.requiredOneOf ?? []).length > 0
      ? [`at least one of [${(contract.requiredOneOf ?? []).join(', ')}]`]
      : [],
  ];
  const invocation = contract.actionField === false
    ? `direct ${contract.action} call without an action field`
    : `action=${contract.action}`;
  return `${invocation} (required: ${formatFields(requiredParts)}; optional: ${formatFields(contract.optional)}`
    + `${contract.rule ? `; rule: ${contract.rule}` : ''})`;
}

function renderToolSurfaceDescription(
  contract: CanonicalToolSurfaceContract,
  options: {
    actions?: readonly CanonicalToolActionContract[];
    purpose?: string;
    output?: string;
    guidance?: string;
    boundary?: string;
    example?: Readonly<Record<string, unknown>>;
  } = {},
): string {
  const actions = options.actions ?? contract.actions;
  return [
    options.purpose ?? contract.purpose,
    `Use ${actions.map(renderActionContract).join('; ')}.`,
    options.boundary
      ? `${options.output ?? contract.output} ${options.boundary}`
      : options.output ?? contract.output,
    options.guidance ?? contract.guidance,
    `Example: ${JSON.stringify(options.example ?? contract.example)}.`,
  ].join(' ');
}

function buildCanonicalDescriptions<T extends Record<string, CanonicalToolSurfaceContract>>(
  contracts: T,
): { readonly [K in keyof T]: string } {
  return Object.fromEntries(
    Object.entries(contracts).map(([name, contract]) => [name, renderToolSurfaceDescription(contract)]),
  ) as { readonly [K in keyof T]: string };
}

export const CANONICAL_TOOL_SURFACE_DESCRIPTIONS = buildCanonicalDescriptions(
  CANONICAL_TOOL_SURFACE_CONTRACTS,
);

export function getCanonicalToolSurfaceDescription(
  name: string,
  variantName?: CanonicalToolSurfaceVariantName,
): string | undefined {
  if (!Object.hasOwn(CANONICAL_TOOL_SURFACE_CONTRACTS, name)) return undefined;
  const contract = CANONICAL_TOOL_SURFACE_CONTRACTS[name as CanonicalToolSurfaceDescriptionName];
  if (!variantName) return renderToolSurfaceDescription(contract);
  const variant = CANONICAL_TOOL_SURFACE_VARIANTS[variantName];
  if (variant.tool !== name) return undefined;
  const actionIds = new Set<string>(variant.actionIds);
  return renderToolSurfaceDescription(contract, {
    actions: contract.actions.filter(candidate => actionIds.has(candidate.id)),
    purpose: variant.purpose,
    output: variant.output,
    guidance: variant.guidance,
    boundary: variant.boundary,
    example: variant.example,
  });
}

export function isCanonicalToolSurfaceDescription(name: string, description: string): boolean {
  if (getCanonicalToolSurfaceDescription(name) === description) return true;
  return Object.keys(CANONICAL_TOOL_SURFACE_VARIANTS).some((variantName) => (
    getCanonicalToolSurfaceDescription(name, variantName as CanonicalToolSurfaceVariantName) === description
  ));
}
