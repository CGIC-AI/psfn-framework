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
import { OPERATIONS_TOOL_CONTRACTS } from './descriptions/operations-contracts.js';

export type {
  CanonicalToolActionContract,
  CanonicalToolSurfaceContract,
} from './descriptions/contracts.js';

export const CANONICAL_TOOL_SURFACE_CONTRACTS = {
  ...CATALOG_BOUNDARY_TOOL_CONTRACTS,
  ...CONTINUITY_TOOL_CONTRACTS,
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
    actionIds: ['initiate_companion'],
    purpose: 'Initiate the exact permitted companion contact from an authorized ICP candidate turn.',
    output: 'It returns the initiation result and lets the destination turn author peer-visible text.',
    guidance: 'Do not use this projection outside the exact candidate companion initiation.',
    boundary: 'This initiation-only projection is permit-bound to the exact candidate and rejects message content or any other notification action.',
    example: {
      action: 'initiate_companion', contact_id: 'contact-123',
      initiation_permit: '11111111-1111-4111-8111-111111111111',
    },
  },
} as const satisfies Record<string, CanonicalToolSurfaceVariant>;

export type CanonicalToolSurfaceVariantName = keyof typeof CANONICAL_TOOL_SURFACE_VARIANTS;

function formatAnyOf(groups: readonly (readonly string[])[]): string {
  return groups
    .map(group => (group.length === 1 ? group[0]! : `[${group.join(', ')}]`))
    .join(' | ');
}

function renderActionContract(contract: CanonicalToolActionContract): string {
  const requiredParts = [
    ...(contract.required.length > 0 ? [contract.required.join(', ')] : []),
    ...(contract.requiredAnyOf ?? []).length > 0
      ? [`one of: ${formatAnyOf(contract.requiredAnyOf ?? [])}`]
      : [],
    ...(contract.requiredOneOf ?? []).length > 0
      ? [`>=1 of: ${(contract.requiredOneOf ?? []).join(', ')}`]
      : [],
  ];
  const invocation = contract.actionField === false
    ? `direct ${contract.action} call`
    : `action=${contract.action}`;
  const argParts: string[] = [];
  if (requiredParts.length > 0) argParts.push(requiredParts.join(', '));
  if (contract.optional.length > 0) argParts.push(`[${contract.optional.join(', ')}]`);
  const detailParts: string[] = [];
  if (argParts.length > 0) detailParts.push(argParts.join('; '));
  if (contract.rule) detailParts.push(contract.rule);
  return detailParts.length > 0 ? `${invocation} (${detailParts.join(' — ')})` : invocation;
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
  const actionsBlock = actions.length > 1
    ? `Use (required args; optional in []):\n${actions.map(item => `- ${renderActionContract(item)}`).join('\n')}`
    : `Use ${actions.map(renderActionContract).join('; ')}.`;
  const output = options.boundary
    ? `${options.output ?? contract.output} ${options.boundary}`
    : options.output ?? contract.output;
  return [
    options.purpose ?? contract.purpose,
    actionsBlock,
    output,
    options.guidance ?? contract.guidance,
    `Example: ${JSON.stringify(options.example ?? contract.example)}.`,
  ].join('\n');
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

export function getCanonicalToolSurfaceDescriptionForActions(
  name: string,
  actionIds: readonly string[],
): string | undefined {
  if (!Object.hasOwn(CANONICAL_TOOL_SURFACE_CONTRACTS, name)) return undefined;
  const contract = CANONICAL_TOOL_SURFACE_CONTRACTS[name as CanonicalToolSurfaceDescriptionName];
  const requested = new Set(actionIds);
  const actions = contract.actions.filter(action => requested.has(action.id));
  if (actions.length !== requested.size) {
    throw new Error(`Unknown canonical ${name} action in policy hydration: ${actionIds.join(', ')}`);
  }
  return renderToolSurfaceDescription(contract, { actions });
}

export function isCanonicalToolSurfaceDescription(name: string, description: string): boolean {
  if (getCanonicalToolSurfaceDescription(name) === description) return true;
  return Object.keys(CANONICAL_TOOL_SURFACE_VARIANTS).some((variantName) => (
    getCanonicalToolSurfaceDescription(name, variantName as CanonicalToolSurfaceVariantName) === description
  ));
}
