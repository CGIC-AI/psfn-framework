import type { AdminSessionMessagesData, SessionEntry } from '$lib/types';

type MessageOntologyView = AdminSessionMessagesData['messageOntologyViews'][number];

interface IcpCorrelationSummary {
  rootInitiationId: string;
  conversationId: string;
  turnId: string;
  deliveryStatus?: string;
}

export interface IcpTransportEvidenceGroup {
  rootInitiationId: string;
  conversationId: string;
  entryCount: number;
  turnCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
  deliveryStatuses: string[];
  entries: SessionEntry[];
}

export interface IcpTranscriptPresentation {
  conversationMessages: SessionEntry[];
  transportEvidence: IcpTransportEvidenceGroup[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseIcpCorrelationSummary(metadata: string | undefined): IcpCorrelationSummary | null {
  if (!metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  const envelope = record(parsed);
  const correlation = record(envelope?.icpCorrelation);
  const rootInitiationId = nonEmptyString(correlation?.rootInitiationId);
  const conversationId = nonEmptyString(correlation?.conversationId);
  const turnId = nonEmptyString(correlation?.turnId);
  if (!rootInitiationId || !conversationId || !turnId) return null;
  const delivery = record(envelope?.icpDelivery);
  const deliveryStatus = nonEmptyString(delivery?.status) ?? undefined;
  return {
    rootInitiationId,
    conversationId,
    turnId,
    ...(deliveryStatus ? { deliveryStatus } : {}),
  };
}

/**
 * Keeps ICP speech in the ordinary transcript while moving exact
 * operator-only transport nodes behind one collapsed evidence group per
 * conversation root. This is a presentation transform only: no journal or
 * audit evidence is deleted or rewritten.
 */
export function buildIcpTranscriptPresentation(
  messages: readonly SessionEntry[],
  ontologyViews: readonly MessageOntologyView[],
): IcpTranscriptPresentation {
  const ontologyById = new Map(ontologyViews.map(view => [view.sessionEntryId, view]));
  const conversationMessages: SessionEntry[] = [];
  const mutableGroups = new Map<string, {
    rootInitiationId: string;
    conversationId: string;
    turnIds: Set<string>;
    deliveryStatuses: Set<string>;
    entries: SessionEntry[];
  }>();

  for (const message of messages) {
    const correlation = parseIcpCorrelationSummary(message.metadata);
    const ontology = ontologyById.get(message.id);
    if (!correlation || ontology?.promptVisibility !== 'operator_only') {
      conversationMessages.push(message);
      continue;
    }
    const key = `${correlation.rootInitiationId}:${correlation.conversationId}`;
    const group = mutableGroups.get(key) ?? {
      rootInitiationId: correlation.rootInitiationId,
      conversationId: correlation.conversationId,
      turnIds: new Set<string>(),
      deliveryStatuses: new Set<string>(),
      entries: [],
    };
    group.turnIds.add(correlation.turnId);
    if (correlation.deliveryStatus) group.deliveryStatuses.add(correlation.deliveryStatus);
    group.entries.push(message);
    mutableGroups.set(key, group);
  }

  const transportEvidence = [...mutableGroups.values()].map(group => ({
    rootInitiationId: group.rootInitiationId,
    conversationId: group.conversationId,
    entryCount: group.entries.length,
    turnCount: group.turnIds.size,
    firstTimestamp: Math.min(...group.entries.map(entry => entry.timestamp)),
    lastTimestamp: Math.max(...group.entries.map(entry => entry.timestamp)),
    deliveryStatuses: [...group.deliveryStatuses].sort(),
    entries: group.entries,
  }));

  return { conversationMessages, transportEvidence };
}
