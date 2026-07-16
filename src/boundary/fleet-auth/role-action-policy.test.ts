import { describe, expect, it } from 'vitest';
import { FLEET_AUTH_ACTIONS, FLEET_AUTH_ROLES } from '../../system/config/fleet-auth-config.js';
import {
  FLEET_AUTH_ACTION_BASE_ROLE,
  FLEET_AUTH_DEFAULT_ROLE_ACTION_POLICY,
  fleetAuthRoleAllowsAction,
} from './role-action-policy.js';

describe('canonical fleet role/action policy', () => {
  it('has an exhaustive golden base role for every closed action', () => {
    const byBaseRole = Object.groupBy(
      FLEET_AUTH_ACTIONS,
      (action) => FLEET_AUTH_ACTION_BASE_ROLE[action] ?? 'none',
    );
    expect(byBaseRole).toEqual({
      none: ['public.read', 'legacy_session.manage', 'recovery.begin'],
      guest: ['companion.read', 'companion.interact'],
      member: ['artifacts.read', 'tool_activity.read', 'memory.read.self', 'memory.jit.self'],
      admin: [
        'embodiment.handoff',
        'garden.read',
        'action_pipe.read',
        'action_pipe.manage',
        'audit.read',
        'autonomy.read',
        'autonomy.manage',
        'charges.read',
        'channels.read',
        'channels.manage',
        'cogsec.read',
        'cogsec.manage',
        'confirmations.read',
        'confirmations.resolve',
        'confirmations.manage',
        'contact_approvals.read',
        'contact_approvals.manage',
        'contacts.read',
        'contacts.manage',
        'contacts.bind',
        'devices.read',
        'settings.read',
        'settings.write',
        'diagnostics.read',
        'graph.read',
        'graph.manage',
        'identity.read',
        'identity.manage',
        'images.read',
        'images.manage',
        'memory.read',
        'memory.manage',
        'models.read',
        'models.manage',
        'places.read',
        'places.manage',
        'prompts.read',
        'prompts.manage',
        'scheduler.read',
        'scheduler.manage',
        'sessions.read',
        'sessions.repair',
        'shared_workspace.read',
        'shared_workspace.manage',
        'skills.read',
        'skills.manage',
        'telemetry.read',
        'tools.read',
        'tools.execute',
        'values.read',
        'wiki.read',
        'wiki.manage',
        'devices.manage',
      ],
      owner: ['roles.manage', 'provider.link'],
    });
  });

  it('evaluates every role/action pair from the single canonical policy', () => {
    for (const role of FLEET_AUTH_ROLES) {
      for (const action of FLEET_AUTH_ACTIONS) {
        expect(fleetAuthRoleAllowsAction(role, action), `${role} ${action}`)
          .toBe(FLEET_AUTH_DEFAULT_ROLE_ACTION_POLICY[role].includes(action));
      }
    }
    expect(FLEET_AUTH_DEFAULT_ROLE_ACTION_POLICY.guest).toEqual([
      'companion.read', 'companion.interact',
    ]);
    expect(FLEET_AUTH_DEFAULT_ROLE_ACTION_POLICY.member).toEqual([
      'companion.read', 'companion.interact', 'artifacts.read', 'tool_activity.read',
      'memory.read.self', 'memory.jit.self',
    ]);
    expect(FLEET_AUTH_DEFAULT_ROLE_ACTION_POLICY.owner).not.toContain('recovery.begin');
  });

  it('fails closed for values outside the closed action vocabulary', () => {
    expect(fleetAuthRoleAllowsAction('owner', 'unknown.action' as never)).toBe(false);
  });
});
