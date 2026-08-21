import { describe, expect, it } from 'vitest';
import type { AdminCogSecEventListData } from '$lib/types';
import {
  listOpenSessionIntegrityIncidents,
  listRemediationSourceChannelOptions,
  resolveIntegrityIncidentSelection,
} from './incident-selection';

function integrityIncident(
  overrides: Partial<AdminCogSecEventListData['events'][number]> = {},
): AdminCogSecEventListData['events'][number] {
  return {
    caseId: 'cogsec_sessionintegrity_0123456789abcdef0123456789abcdef01234567',
    type: 'session_integrity',
    severity: 'high',
    status: 'open',
    sourceChannelId: 'retired-channel',
    affectedLogicalSessionIds: ['retired-session'],
    affectedRanges: [{
      sourceChannelId: 'retired-channel',
      logicalSessionId: 'retired-session',
      startEntryId: 14,
      endEntryId: 18,
      messageIdCount: 0,
      sourceMessageIdCount: 0,
      discordMessageIdCount: 0,
    }],
    actions: [],
    safeSummary: 'Session integrity check failed for five L0 journal entries.',
    tombstonedL0RowCount: 0,
    affectedArtifactCounts: {},
    resultCounters: {},
    epochCuts: [],
    createdAt: '2026-08-03T20:37:18.584Z',
    updatedAt: '2026-08-03T20:46:31.564Z',
    actor: 'system:session-integrity',
    sealedArtifactCount: 0,
    sealedHashCount: 0,
    ...overrides,
  };
}

describe('CogSec remediation incident selection', () => {
  it('lists and resolves an open historical integrity incident without a current route', () => {
    const incident = integrityIncident({});
    expect(listOpenSessionIntegrityIncidents([
      incident,
      integrityIncident({ caseId: 'cogsec_closed_0123456789abcdef01234567', status: 'applied' }),
      integrityIncident({ caseId: 'cogsec_firewall_0123456789abcdef01234567', type: 'intake_firewall' }),
    ])).toEqual([incident]);
    expect(resolveIntegrityIncidentSelection(incident)).toEqual({
      caseId: incident.caseId,
      sourceChannelId: 'retired-channel',
      logicalSessionId: 'retired-session',
      severity: 'high',
      startEntryId: 14,
      endEntryId: 18,
    });
    expect(listRemediationSourceChannelOptions({
      routes: [{ sourceChannelId: 'active-route' }],
      channels: [{ channelId: 'known-session' }],
      incidents: [incident],
    })).toEqual(['active-route', 'known-session', 'retired-channel']);
  });

  it('returns an empty incident list for a healthy event set', () => {
    expect(listOpenSessionIntegrityIncidents([])).toEqual([]);
  });
});
