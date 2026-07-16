import {
  FLEET_AUTH_ACTIONS,
  FLEET_AUTH_ROLES,
  type FleetAuthAction,
  type FleetAuthRole,
} from '../../system/config/fleet-auth-config.js';

export type FleetAuthBaseRole = FleetAuthRole | null;

const ROLE_RANK: Readonly<Record<FleetAuthRole, number>> = Object.freeze({
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3,
});

/**
 * The one widening policy for the closed fleet action vocabulary. A null base
 * role means that no routine role authorizes the action: public and recovery
 * entry are governed by their separate route classifications.
 */
export const FLEET_AUTH_ACTION_BASE_ROLE: Readonly<Record<FleetAuthAction, FleetAuthBaseRole>> =
  Object.freeze({
    'public.read': null,
    'legacy_session.manage': null,
    'recovery.begin': null,
    'companion.read': 'guest',
    'companion.interact': 'guest',
    'embodiment.handoff': 'admin',
    'garden.read': 'admin',
    'action_pipe.read': 'admin',
    'action_pipe.manage': 'admin',
    'audit.read': 'admin',
    'autonomy.read': 'admin',
    'autonomy.manage': 'admin',
    'charges.read': 'admin',
    'channels.read': 'admin',
    'channels.manage': 'admin',
    'cogsec.read': 'admin',
    'cogsec.manage': 'admin',
    'confirmations.read': 'admin',
    'confirmations.resolve': 'admin',
    'confirmations.manage': 'admin',
    'artifacts.read': 'member',
    'contact_approvals.read': 'admin',
    'contact_approvals.manage': 'admin',
    'contacts.read': 'admin',
    'contacts.manage': 'admin',
    'contacts.bind': 'admin',
    'devices.read': 'admin',
    'settings.read': 'admin',
    'settings.write': 'admin',
    'diagnostics.read': 'admin',
    'graph.read': 'admin',
    'graph.manage': 'admin',
    'identity.read': 'admin',
    'identity.manage': 'admin',
    'images.read': 'admin',
    'images.manage': 'admin',
    'memory.read': 'admin',
    'memory.manage': 'admin',
    'models.read': 'admin',
    'models.manage': 'admin',
    'places.read': 'admin',
    'places.manage': 'admin',
    'prompts.read': 'admin',
    'prompts.manage': 'admin',
    'scheduler.read': 'admin',
    'scheduler.manage': 'admin',
    'sessions.read': 'admin',
    'sessions.repair': 'admin',
    'shared_workspace.read': 'admin',
    'shared_workspace.manage': 'admin',
    'skills.read': 'admin',
    'skills.manage': 'admin',
    'telemetry.read': 'admin',
    'tool_activity.read': 'member',
    'tools.read': 'admin',
    'tools.execute': 'admin',
    'values.read': 'admin',
    'wiki.read': 'admin',
    'wiki.manage': 'admin',
    'roles.manage': 'owner',
    'memory.read.self': 'member',
    'memory.jit.self': 'member',
    'devices.manage': 'admin',
    'provider.link': 'owner',
  });

export function fleetAuthRoleAllowsAction(
  role: FleetAuthRole,
  action: FleetAuthAction,
): boolean {
  if (!Object.hasOwn(FLEET_AUTH_ACTION_BASE_ROLE, action)) return false;
  const baseRole = FLEET_AUTH_ACTION_BASE_ROLE[action];
  return baseRole !== null && ROLE_RANK[role] >= ROLE_RANK[baseRole];
}

export const FLEET_AUTH_DEFAULT_ROLE_ACTION_POLICY: Readonly<
Record<FleetAuthRole, readonly FleetAuthAction[]>
> = Object.freeze(Object.fromEntries(FLEET_AUTH_ROLES.map((role) => [
  role,
  Object.freeze(FLEET_AUTH_ACTIONS.filter((action) => fleetAuthRoleAllowsAction(role, action))),
])) as Record<FleetAuthRole, readonly FleetAuthAction[]>);
