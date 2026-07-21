import { fleetAuthRoleAllowsAction } from '../../boundary/fleet-auth/role-action-policy.js';
import {
  FLEET_AUTH_ACTIONS,
  FLEET_AUTH_ROLES,
  type FleetAuthAction,
  type FleetAuthRole,
} from '../../system/config/fleet-auth-config.js';
import { parseBooleanEnv } from '../../shared/utils/env.js';
import { normalizeTestingHarnessApiPrincipalId } from './http/auth.js';

const GARDEN_ADMIN_FIELD = 'channels.json.api.testingHarness.gardenAdmin';
const OPERATOR_GRANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const TESTING_HARNESS_GARDEN_ADMIN_ACTIONS = Object.freeze([
  'action_pipe.read',
  'action_pipe.manage',
  'cogsec.read',
  'cogsec.manage',
  'confirmations.read',
  'confirmations.manage',
  'devices.manage',
  'models.read',
  'prompts.read',
  'settings.read',
  'settings.write',
] as const satisfies readonly FleetAuthAction[]);

export interface TestingHarnessGardenAdminConfig {
  readonly enabled: true;
  readonly principalId: string;
  readonly operatorGrantId: string;
  readonly role: FleetAuthRole;
  readonly allowedActions: readonly FleetAuthAction[];
}

export const TESTING_HARNESS_GARDEN_VERIFIER_ENV =
  'PSFN_TESTING_HARNESS_GARDEN_VERIFIER';

function configuredString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${fieldName} must be a string`);
  const parsed = value.trim();
  if (!parsed) throw new Error(`${fieldName} must not be empty`);
  return parsed;
}

function configuredBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'boolean'
    ? value
    : typeof value === 'string'
      ? parseBooleanEnv(value)
      : undefined;
  if (parsed === undefined) throw new Error(`${fieldName} must be a boolean`);
  return parsed;
}

function configuredStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array of strings`);
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new Error(`${fieldName} must contain only strings`);
    const parsed = entry.trim();
    if (!parsed) throw new Error(`${fieldName} must not contain empty strings`);
    return parsed;
  });
}

export function resolveTestingHarnessGardenVerifierConfig(
  gatewayConfig: TestingHarnessGardenAdminConfig | undefined,
  env: NodeJS.ProcessEnv,
): { readonly enabled: true } | undefined {
  const raw = env[TESTING_HARNESS_GARDEN_VERIFIER_ENV];
  const enabled = parseBooleanEnv(raw);
  if (raw?.trim() && enabled === undefined) {
    throw new Error(`${TESTING_HARNESS_GARDEN_VERIFIER_ENV} must be a boolean`);
  }
  if (!enabled) return undefined;
  if (!gatewayConfig?.enabled) {
    throw new Error(
      `${TESTING_HARNESS_GARDEN_VERIFIER_ENV} requires complete gateway-side gardenAdmin config`,
    );
  }
  return Object.freeze({ enabled: true });
}

export function parseTestingHarnessGardenAdminConfig(
  rawGardenAdmin: Record<string, unknown>,
): TestingHarnessGardenAdminConfig | undefined {
  const supportedKeys = new Set([
    'enabled',
    'principalId',
    'operatorGrantId',
    'role',
    'allowedActions',
  ]);
  const unknownKeys = Object.keys(rawGardenAdmin).filter(key => !supportedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${GARDEN_ADMIN_FIELD} has unsupported keys: ${unknownKeys.join(', ')}`);
  }

  const enabled = configuredBoolean(rawGardenAdmin.enabled, `${GARDEN_ADMIN_FIELD}.enabled`);
  if (enabled === undefined) throw new Error(`${GARDEN_ADMIN_FIELD}.enabled must be configured`);
  if (!enabled) {
    if (Object.keys(rawGardenAdmin).some(key => key !== 'enabled')) {
      throw new Error(`${GARDEN_ADMIN_FIELD} disabled form accepts only enabled`);
    }
    return undefined;
  }

  const principalId = configuredString(rawGardenAdmin.principalId, `${GARDEN_ADMIN_FIELD}.principalId`);
  if (!principalId) throw new Error(`${GARDEN_ADMIN_FIELD}.principalId must be configured`);
  const normalizedPrincipalId = normalizeTestingHarnessApiPrincipalId(principalId);

  const operatorGrantId = configuredString(
    rawGardenAdmin.operatorGrantId,
    `${GARDEN_ADMIN_FIELD}.operatorGrantId`,
  );
  if (!operatorGrantId) throw new Error(`${GARDEN_ADMIN_FIELD}.operatorGrantId must be configured`);
  if (!OPERATOR_GRANT_ID_PATTERN.test(operatorGrantId)) {
    throw new Error(`${GARDEN_ADMIN_FIELD}.operatorGrantId is invalid`);
  }

  const role = configuredString(rawGardenAdmin.role, `${GARDEN_ADMIN_FIELD}.role`);
  if (!role || !(FLEET_AUTH_ROLES as readonly string[]).includes(role)) {
    throw new Error(`${GARDEN_ADMIN_FIELD}.role must be one of: ${FLEET_AUTH_ROLES.join(', ')}`);
  }

  const allowedActions = configuredStringArray(
    rawGardenAdmin.allowedActions,
    `${GARDEN_ADMIN_FIELD}.allowedActions`,
  );
  if (!allowedActions || allowedActions.length === 0) {
    throw new Error(`${GARDEN_ADMIN_FIELD}.allowedActions must be configured`);
  }
  if (new Set(allowedActions).size !== allowedActions.length) {
    throw new Error(`${GARDEN_ADMIN_FIELD}.allowedActions must not contain duplicates`);
  }

  const supportedActions = new Set<string>(TESTING_HARNESS_GARDEN_ADMIN_ACTIONS);
  for (const action of allowedActions) {
    if (!(FLEET_AUTH_ACTIONS as readonly string[]).includes(action) || !supportedActions.has(action)) {
      throw new Error(`${GARDEN_ADMIN_FIELD}.allowedActions contains unsupported action ${action}`);
    }
    if (!fleetAuthRoleAllowsAction(role as FleetAuthRole, action as FleetAuthAction)) {
      throw new Error(`${GARDEN_ADMIN_FIELD}.role does not authorize ${action}`);
    }
  }

  return Object.freeze({
    enabled: true,
    principalId: normalizedPrincipalId,
    operatorGrantId,
    role: role as FleetAuthRole,
    allowedActions: Object.freeze(allowedActions as FleetAuthAction[]),
  });
}
