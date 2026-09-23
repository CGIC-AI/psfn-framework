import { isObjectRecord as isRecord } from '../../../src/shared/utils/types.js';
import { isLowercaseRfc4122Uuid } from './protocol/validation.js';
import { withFleetSessionRequestLock } from './fleet-session.js';
import type { CompanionSystemMonitorEvidence } from '../../../src/shared/contracts/companion-system-monitor.js';

export interface MonitorLane {
  id: string; label: string; status: string; source: string; sinceProcessStart: boolean;
  lastEventAt: number | null; lastSuccessAt: number | null; nextRunDueAt: number | null;
  reason: string | null; counts: Array<[string, number]>;
  recent: Array<{ at: number; outcome: string; reason: string | null }>;
}
interface MonitorHealth {
  generatedAt: number; processStartedAt: number; lanes: MonitorLane[];
  configuration: CompanionSystemMonitorEvidence | null;
}
interface MonitorIncident { id: string; code: string; status: string; at: number; count: number; scope: 'companion' | 'system' }
interface MonitorProvider { at: number; provider: string; model: string; status: string; servingProvider: string | null }
export type MonitorSource<T> = { status: 'available'; data: T } | { status: 'unavailable' | 'forbidden' | 'error' };
export interface SystemMonitorSnapshot {
  companionId: string; fetchedAt: number;
  health: MonitorSource<MonitorHealth>; incidents: MonitorSource<MonitorIncident[]>; providers: MonitorSource<MonitorProvider[]>;
}

function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('Malformed monitor evidence'); return value; }
function code(value: unknown): string | null { return typeof value === 'string' && /^[a-zA-Z0-9_.:/ -]{1,160}$/u.test(value) ? value : null; }
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(row => !isRecord(row))) throw new Error('Malformed monitor evidence');
  return value as Record<string, unknown>[];
}
function parseConfiguration(value: unknown, companionId: string): CompanionSystemMonitorEvidence | null {
  if (value === undefined) return null;
  if (!isRecord(value) || value.companionId !== companionId
    || !['off', 'shadow', 'on'].includes(String(value.emosimProactivityMode))
    || typeof value.freeTimeEnabled !== 'boolean' || typeof value.socialDesireEnabled !== 'boolean'
    || typeof value.weightedThoughtOutreachEnabled !== 'boolean' || !isRecord(value.proactive)) throw new Error('Monitor companion scope mismatch');
  const proactive = value.proactive;
  if (proactive.status === 'available') {
    if (!isRecord(proactive.summary) || number(proactive.summary.total) === null) throw new Error('Malformed proactive evidence');
    const states = rows(proactive.summary.states).map(row => {
      if (!['received', 'off', 'shadow', 'applied', 'no_live_desire', 'lane_disabled', 'interrupted'].includes(String(row.state))
        || number(row.count) === null || number(row.lastUpdatedAtMs) === null) throw new Error('Malformed proactive state');
      return { state: text(row.state), count: Number(row.count), lastUpdatedAtMs: Number(row.lastUpdatedAtMs) };
    });
    return { companionId, freeTimeEnabled: value.freeTimeEnabled, socialDesireEnabled: value.socialDesireEnabled,
      weightedThoughtOutreachEnabled: value.weightedThoughtOutreachEnabled, emosimProactivityMode: value.emosimProactivityMode as 'off' | 'shadow' | 'on',
      proactive: { status: 'available', summary: { total: Number(proactive.summary.total), states,
        lastFiredAtMs: number(proactive.summary.lastFiredAtMs), lastDeliveredAtMs: number(proactive.summary.lastDeliveredAtMs) } } };
  }
  if (proactive.status !== 'unavailable' && proactive.status !== 'error') throw new Error('Malformed proactive availability');
  return { companionId, freeTimeEnabled: value.freeTimeEnabled, socialDesireEnabled: value.socialDesireEnabled,
    weightedThoughtOutreachEnabled: value.weightedThoughtOutreachEnabled, emosimProactivityMode: value.emosimProactivityMode as 'off' | 'shadow' | 'on', proactive: { status: proactive.status } };
}
export function parseMonitorHealth(value: unknown, companionId: string): MonitorHealth {
  if (!isRecord(value) || number(value.generatedAt) === null || number(value.processStartedAt) === null) throw new Error('Malformed monitor snapshot');
  return { generatedAt: Number(value.generatedAt), processStartedAt: Number(value.processStartedAt), configuration: parseConfiguration(value.monitor, companionId),
    lanes: rows(value.lanes).map(row => {
      if (!['ok', 'skipped', 'degraded', 'failed', 'stale', 'paused', 'never'].includes(String(row.status))) throw new Error('Unknown monitor status');
      const recent = rows(row.recent).map(event => ({ at: Number(event.at), outcome: text(event.outcome), reason: code(event.reason) }));
      return { id: text(row.id), label: text(row.label), status: text(row.status), source: text(row.source), sinceProcessStart: row.sinceProcessStart === true,
        lastEventAt: number(row.lastEventAt), lastSuccessAt: number(row.lastSuccessAt) ?? recent.find(event => event.outcome === 'ran')?.at ?? null,
        nextRunDueAt: number(row.nextRunDueAt), reason: code(row.lastReason ?? row.deniedReason),
        counts: isRecord(row.counts) ? Object.entries(row.counts).filter((entry): entry is [string, number] => number(entry[1]) !== null) : [], recent };
    }) };
}
function parseIncidents(value: unknown, companionId: string): MonitorIncident[] {
  if (!isRecord(value) || !isRecord(value.scope) || !isRecord(value.scope.owner)
    || value.scope.owner.kind !== 'companion' || value.scope.owner.companionId !== companionId) throw new Error('Incident companion scope mismatch');
  return rows(value.incidents).map(row => {
    if (!isRecord(row.owner) || (row.owner.kind !== 'system' && (row.owner.kind !== 'companion' || row.owner.companionId !== companionId))) throw new Error('Incident owner mismatch');
    return { id: text(row.incidentId), code: text(row.code), status: text(row.status), at: Number(row.lastObservedAtMs), count: Number(row.occurrenceCount), scope: row.owner.kind as 'system' | 'companion' };
  });
}
function parseServingProvider(metadata: unknown): string | null {
  if (!isRecord(metadata) || !isRecord(metadata.providerResponse)) return null;
  const response = metadata.providerResponse;
  if (Array.isArray(response.conflicts) && response.conflicts.includes('servingProvider')) return null;
  return code(response.servingProvider);
}
function parseProviders(value: unknown, companionId: string): MonitorProvider[] {
  if (!isRecord(value)) throw new Error('Malformed provider evidence');
  return rows(value.recentEvents).filter(row => isRecord(row.attribution) && row.attribution.companionId === companionId
    && row.telemetryVisibility === 'operator_visible').map(row => ({
    at: Number(row.recordedAtMs), provider: text(row.provider), model: text(row.model), status: text(row.status),
    servingProvider: parseServingProvider(row.metadata),
  }));
}

/** Same-origin Garden authorization remains authoritative; never fall back to primary or fleet data. */
export async function loadSystemMonitor(companionId: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<SystemMonitorSnapshot> {
  if (!isLowercaseRfc4122Uuid(companionId)) throw new Error('Select an authorized companion');
  const base = `/companions/${companionId}/garden/api/admin/`;
  async function read<T>(path: string, parse: (value: unknown) => T): Promise<MonitorSource<T>> {
    try {
      return await withFleetSessionRequestLock(async requestSignal => {
        const response = await fetchImpl(base + path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, requestSignal]) });
        if (response.status === 401 || response.status === 403) return { status: 'forbidden' };
        if (response.status === 404 || response.status === 503) return { status: 'unavailable' };
        if (!response.ok) return { status: 'error' };
        return { status: 'available', data: parse(await response.json()) };
      });
    } catch {
      return { status: 'error' };
    }
  }
  const [health, incidents, providers] = await Promise.all([
    read('subsystem-health', value => parseMonitorHealth(value, companionId)),
    read('incidents', value => parseIncidents(value, companionId)),
    read(`model-usage?range=today&limit=5&companionId=${companionId}`, value => parseProviders(value, companionId)),
  ]);
  return { companionId, fetchedAt: Date.now(), health, incidents, providers };
}
