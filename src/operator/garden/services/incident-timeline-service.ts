// ── Garden incident timeline (bead psfn-framework-7qeo1.24.6) ──
//
// The operator surface for the incidents the detectors correlate and the alert
// path pages on. It fabricates nothing: every incident here is reconstructed
// from rows the runtime actually wrote to the persisted health stream, through
// the SAME projection the alert bundle uses, so the incident id in a
// notification and the incident id on this surface are the same value by
// construction rather than by convention. Healthy traffic writes no incident
// statements, so this surface is empty.
//
// It is a read seam and nothing more: the service is handed one bounded stream
// READ function, exactly like the incident investigator, so an operator page
// cannot mutate the health plane it is displaying.
//
// Scope and its honest limit. The gateway and the agent each persist into their
// own pool scope: the agent's store is pinned to its companion tenant schema in
// fleet mode, the gateway's runs on its own credential's default search_path.
// This service reads the stream of the process it runs in — the agent's — so it
// shows every incident that landed in that table. Where both processes resolve
// to the same table (a single-companion deployment sharing one database and
// search_path) that is the unified gateway+agent view; where they do not, it is
// this process's stream, and the surface says which by reporting the scope it
// read. Joining two separately-credentialed stores into one operator view needs
// a cross-process read seam that does not exist yet.

import {
  resolveHealthEventOwner,
  type HealthEvent,
  type HealthEventOwner,
} from '../../../shared/contracts/health-event.js';
import type { HealthDetectorsConfig } from '../../../system/config/scheduler-config/health-detectors.js';
import { sameHealthEventOwner } from '../../../shared/observability/health-detectors/owner.js';
import { summarizeIncidents } from '../../../shared/observability/incident-alerts/incident-view.js';
import type { IncidentSummary } from '../../../shared/observability/incident-alerts/contracts.js';
import type { IncidentStreamRead } from '../../../shared/observability/incident-alerts/investigator.js';

/**
 * Which stream this snapshot was read from. Stated rather than implied: an
 * operator looking at an empty list needs to know whether the runtime is quiet
 * or whether they are looking at one process's table.
 */
export interface IncidentTimelineScope {
  /** The tenancy whose incidents this surface may show, beside system-owned ones. */
  owner: HealthEventOwner;
  /** The process whose persisted stream was read. */
  process: 'agent';
  /** Lookback applied, from the owner file. */
  windowMs: number;
}

export interface IncidentTimelineSnapshot {
  generatedAt: number;
  scope: IncidentTimelineScope;
  /** Newest activity first; empty under healthy traffic. */
  incidents: IncidentSummary[];
}

export interface AdminIncidentTimelineService {
  getSnapshot(): Promise<IncidentTimelineSnapshot>;
}

export interface AdminIncidentTimelineServiceOptions {
  /**
   * The service's only authority over the health plane, mirroring the incident
   * investigator: one bounded read, no store handle, so an operator surface
   * cannot write to the stream it renders.
   */
  readStream: IncidentStreamRead;
  config: () => HealthDetectorsConfig;
  /** This runtime's companion identity; absent for a shard with no core tenancy. */
  companionId?: string;
  now?: () => number;
}

export class AdminIncidentTimelineDataService implements AdminIncidentTimelineService {
  private readonly owner: HealthEventOwner;

  constructor(private readonly options: AdminIncidentTimelineServiceOptions) {
    this.owner = resolveHealthEventOwner(options.companionId);
  }

  async getSnapshot(): Promise<IncidentTimelineSnapshot> {
    const config = this.options.config();
    const nowMs = (this.options.now ?? (() => Date.now()))();
    const rows = await this.options.readStream({
      sinceMs: Math.max(0, nowMs - config.incidentWindowMs),
      limit: config.incidentScanLimit,
    });
    return {
      generatedAt: nowMs,
      scope: {
        owner: this.owner,
        process: 'agent',
        windowMs: config.incidentWindowMs,
      },
      incidents: summarizeIncidents(this.visibleRows(rows), {
        timelineLimit: config.incidentAlerts.bundleEventLimit,
      }),
    };
  }

  /**
   * Tenancy fence. A companion-owned incident is visible only to its own
   * companion's Garden; system-owned incidents (a shared pool, a missing
   * operator sink) belong to the runtime and are visible to whoever can read
   * this surface. Applied before projection so a foreign row cannot even
   * contribute evidence to an incident shown here.
   *
   * In fleet mode the agent's store is already pinned to its tenant schema, so
   * this is a second, independent fence rather than the only one — a
   * misconfigured search_path fails closed here instead of leaking a
   * companion's incidents onto another companion's page.
   */
  private visibleRows(rows: readonly HealthEvent[]): HealthEvent[] {
    return rows.filter(row => (
      row.owner.kind === 'system' || sameHealthEventOwner(row.owner, this.owner)
    ));
  }
}
