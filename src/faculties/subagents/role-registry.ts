import { isRecord } from '../../shared/utils/types.js';
import { AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN } from '../../core/agent/turn-limits.js';

/**
 * bead 7ym.2.1 — named subagent role profiles (researcher / awaiter / reviewer /
 * implementer / observer …) layered over inherited companion identity.
 *
 * A role is a bounded *narrowing* posture, never a widening one: it layers
 * task-scoped instructions over the inherited companion system prompt and may
 * only restrict the tools, capabilities, turns, timeout, and concurrency the
 * parent tier already permits (enforced in bead 7ym.2.2). The registry is a
 * schema-owned settings structure — there is no env-var side channel — and
 * every accessor fails closed on an unknown role or malformed definition.
 */
export interface SubagentRoleDefinition {
  /**
   * Task-posture instructions layered over the inherited companion identity
   * (see {@link layerRoleSystemPrompt}). Required and non-empty: a role with no
   * instructions carries no posture and is rejected at parse time.
   */
  readonly instructions: string;
  /**
   * Field-level identity inheritance. Default (`true`/omitted): the role's
   * instructions are layered OVER the inherited companion system prompt so the
   * child stays a bounded extension of the companion. Explicit `false`: the
   * role replaces inherited identity wholesale (opt-out, never the default).
   */
  readonly inheritIdentity?: boolean;
  /**
   * Direct tool names this role is allowed to use. When present the injected
   * subagent toolset is intersected with this allow-list — a role can only
   * NARROW the tier's toolset, never add a tool the tier does not grant. Absent
   * ⇒ no role-level tool restriction beyond the tier blocklist.
   */
  readonly allowedTools?: readonly string[];
  /** Hard ceiling on bounded-loop turns; clamped against the tier turn cap. */
  readonly maxTurns?: number;
  /** Wall-clock deadline (ms) for this role's bounded run. */
  readonly timeoutMs?: number;
  /** Concurrency ceiling on simultaneously active tasks under this role. */
  readonly maxConcurrent?: number;
  /**
   * Capability tokens this role narrows to. When present the advertised
   * capabilities are intersected with this list before the parent-tier grant
   * derivation, so a role can only drop capability tokens, never add them.
   */
  readonly capabilities?: readonly string[];
}

export interface SubagentRoleRegistryConfig {
  /** Named role profiles keyed by role name. */
  readonly roles: Readonly<Record<string, SubagentRoleDefinition>>;
}

export interface ResolvedSubagentRole {
  readonly name: string;
  readonly definition: SubagentRoleDefinition;
}

export function createEmptySubagentRoleRegistryConfig(): SubagentRoleRegistryConfig {
  return { roles: {} };
}

function normalizeRoleName(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldPath} must be a string role name.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldPath} must be a non-empty role name.`);
  }
  return normalized;
}

function parseStringList(value: unknown, fieldPath: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an array of strings.`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      throw new Error(`${fieldPath}[${index}] must be a string.`);
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new Error(`${fieldPath}[${index}] must be a non-empty string.`);
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function parseBoundedInteger(
  value: unknown,
  fieldPath: string,
  { min, max }: { min: number; max?: number },
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${fieldPath} must be an integer.`);
  }
  if (value < min) {
    throw new Error(`${fieldPath} must be >= ${min}.`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${fieldPath} must be <= ${max}.`);
  }
  return value;
}

function parseRoleDefinition(value: unknown, fieldPath: string): SubagentRoleDefinition {
  if (!isRecord(value)) {
    throw new Error(`${fieldPath} must be a role-definition object.`);
  }
  const {
    instructions,
    inheritIdentity,
    allowedTools,
    maxTurns,
    timeoutMs,
    maxConcurrent,
    capabilities,
    ...rest
  } = value;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) {
    throw new Error(`${fieldPath} has unknown keys: ${unknownKeys.sort().join(', ')}.`);
  }
  if (typeof instructions !== 'string' || instructions.trim().length === 0) {
    throw new Error(`${fieldPath}.instructions must be a non-empty string.`);
  }
  const definition: {
    instructions: string;
    inheritIdentity?: boolean;
    allowedTools?: readonly string[];
    maxTurns?: number;
    timeoutMs?: number;
    maxConcurrent?: number;
    capabilities?: readonly string[];
  } = { instructions: instructions.trim() };
  if (inheritIdentity !== undefined) {
    if (typeof inheritIdentity !== 'boolean') {
      throw new Error(`${fieldPath}.inheritIdentity must be a boolean.`);
    }
    definition.inheritIdentity = inheritIdentity;
  }
  if (allowedTools !== undefined) {
    definition.allowedTools = Object.freeze(parseStringList(allowedTools, `${fieldPath}.allowedTools`));
  }
  if (maxTurns !== undefined) {
    definition.maxTurns = parseBoundedInteger(maxTurns, `${fieldPath}.maxTurns`, {
      min: 1,
      max: AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN,
    });
  }
  if (timeoutMs !== undefined) {
    definition.timeoutMs = parseBoundedInteger(timeoutMs, `${fieldPath}.timeoutMs`, { min: 1 });
  }
  if (maxConcurrent !== undefined) {
    definition.maxConcurrent = parseBoundedInteger(maxConcurrent, `${fieldPath}.maxConcurrent`, {
      min: 1,
    });
  }
  if (capabilities !== undefined) {
    definition.capabilities = Object.freeze(parseStringList(capabilities, `${fieldPath}.capabilities`));
  }
  return Object.freeze(definition);
}

/**
 * Fail-closed parse of the schema-owned role registry. A malformed registry,
 * unknown key, or invalid role definition throws rather than silently coercing;
 * an absent/empty registry is a valid empty registry (no roles configured).
 */
export function parseSubagentRoleRegistryConfig(
  value: unknown,
  fieldPath: string,
): SubagentRoleRegistryConfig {
  if (value === undefined || value === null) {
    return createEmptySubagentRoleRegistryConfig();
  }
  if (!isRecord(value)) {
    throw new Error(`${fieldPath} must be a subagent-role registry object.`);
  }
  const { roles, ...rest } = value;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) {
    throw new Error(`${fieldPath} has unknown keys: ${unknownKeys.sort().join(', ')}.`);
  }
  if (roles === undefined) {
    return createEmptySubagentRoleRegistryConfig();
  }
  if (!isRecord(roles)) {
    throw new Error(`${fieldPath}.roles must be an object keyed by role name.`);
  }
  const parsed: Record<string, SubagentRoleDefinition> = {};
  for (const [name, definition] of Object.entries(roles)) {
    const roleName = normalizeRoleName(name, `${fieldPath}.roles key`);
    if (roleName !== name) {
      throw new Error(
        `${fieldPath}.roles key "${name}" must not carry surrounding whitespace.`,
      );
    }
    parsed[roleName] = parseRoleDefinition(definition, `${fieldPath}.roles.${roleName}`);
  }
  return Object.freeze({ roles: Object.freeze(parsed) });
}

/**
 * Resolve a named role, failing closed on an unknown role with the known-role
 * set surfaced for diagnostics. A blank name is rejected before lookup.
 */
export function resolveSubagentRole(
  registry: SubagentRoleRegistryConfig | undefined,
  roleName: string,
): ResolvedSubagentRole {
  const normalized = roleName.trim();
  if (!normalized) {
    throw new Error('Subagent role name must be a non-empty string.');
  }
  // Fail closed on prototype-chain names ('__proto__', 'constructor',
  // 'hasOwnProperty', 'toString', …): a bare `roles[normalized]` lookup would
  // resolve these to inherited Object.prototype members (a phantom "role") and
  // later crash with an uncaught TypeError outside the spawn try/catch. Gate on
  // own-property presence so every unknown name throws the structured error.
  const roles = registry?.roles;
  if (!roles || !Object.hasOwn(roles, normalized)) {
    const known = registry ? Object.keys(registry.roles).sort() : [];
    throw new Error(
      `Unknown subagent role "${normalized}". `
      + (known.length > 0
        ? `Known roles: ${known.join(', ')}.`
        : 'No subagent roles are configured.'),
    );
  }
  return { name: normalized, definition: roles[normalized] };
}

/**
 * Layer the effective system prompt for a bounded child, preserving field-level
 * identity inheritance:
 * - An explicit per-spawn `systemPrompt` override always wins wholesale.
 * - With a role and default inheritance, the role instructions are appended
 *   UNDER the inherited companion identity (never replacing it).
 * - A role that opts out (`inheritIdentity: false`) replaces the identity with
 *   its own instructions.
 * - No role ⇒ the inherited companion identity, unchanged.
 */
export function layerRoleSystemPrompt(
  parentSystemPrompt: string,
  requestSystemPrompt: string | undefined,
  role: ResolvedSubagentRole | null,
): string {
  if (typeof requestSystemPrompt === 'string' && requestSystemPrompt.trim().length > 0) {
    return requestSystemPrompt;
  }
  if (!role) {
    return parentSystemPrompt;
  }
  const instructions = role.definition.instructions.trim();
  const inherit = role.definition.inheritIdentity !== false;
  if (!inherit) {
    return instructions.length > 0 ? instructions : parentSystemPrompt;
  }
  if (instructions.length === 0) {
    return parentSystemPrompt;
  }
  return `${parentSystemPrompt}\n\n## Role: ${role.name}\n\n${instructions}`;
}
