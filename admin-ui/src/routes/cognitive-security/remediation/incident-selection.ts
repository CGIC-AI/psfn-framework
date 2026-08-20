import type {
  AdminCogSecEventListData,
  AdminSessionRouteView,
  ChannelInfo,
} from '$lib/types';

type OperatorEvent = AdminCogSecEventListData['events'][number];

export interface CogSecIntegrityIncidentSelection {
  caseId: string;
  sourceChannelId: string;
  logicalSessionId: string;
  severity: OperatorEvent['severity'];
  startEntryId?: number;
  endEntryId?: number;
}

export function listOpenSessionIntegrityIncidents(
  events: AdminCogSecEventListData['events'],
): AdminCogSecEventListData['events'] {
  return events.filter(event => event.type === 'session_integrity' && event.status === 'open');
}

export function resolveIntegrityIncidentSelection(
  event: OperatorEvent,
): CogSecIntegrityIncidentSelection {
  if (event.type !== 'session_integrity' || event.status !== 'open') {
    throw new Error('Only an open session-integrity incident can seed remediation');
  }
  const range = event.affectedRanges.find(candidate => (
    candidate.sourceChannelId === event.sourceChannelId
    || candidate.logicalSessionId === event.sourceChannelId
  )) ?? event.affectedRanges[0];
  const logicalSessionId = range?.logicalSessionId
    ?? event.affectedLogicalSessionIds[0]
    ?? event.sourceChannelId;
  return {
    caseId: event.caseId,
    sourceChannelId: event.sourceChannelId,
    logicalSessionId,
    severity: event.severity,
    ...(range?.startEntryId !== undefined ? { startEntryId: range.startEntryId } : {}),
    ...(range?.endEntryId !== undefined ? { endEntryId: range.endEntryId } : {}),
  };
}

export function listRemediationSourceChannelOptions(input: {
  routes: readonly Pick<AdminSessionRouteView, 'sourceChannelId'>[];
  channels: readonly Pick<ChannelInfo, 'channelId'>[];
  incidents: AdminCogSecEventListData['events'];
}): string[] {
  return [...new Set([
    ...input.routes.map(route => route.sourceChannelId),
    ...input.channels.map(channel => channel.channelId),
    ...input.incidents.map(event => event.sourceChannelId),
  ])].sort((left, right) => left.localeCompare(right));
}
