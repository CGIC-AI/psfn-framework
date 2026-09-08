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
// Scope, stated rather than implied (bead psfn-framework-e5r0s). This service
// runs in the agent process and reads that process's tenant-pinned stream. In a
// single-companion deployment the gateway resolves to the same table, so that
// one read already IS the unified view. In fleet mode it is not: the gateway
// writes into its own scope, and its incidents — a Postgres pool storm, a
// missing operator sink — were invisible here. So in fleet mode a SECOND,
// read-only stream is opened over the shared schema the gateway now writes its
// system-owned observations into, and the two are merged.
//
// Merging does not widen what a companion may see. Both streams pass the same
// tenancy fence below, which admits system-owned rows and this companion's own
// and nothing else; the shared stream holds only system-owned rows by
// construction, so the fence is what makes that a guarantee rather than a
// convention. The snapshot reports every scope it actually read, so an operator
// looking at an empty list can tell a quiet runtime from a partial view.

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
  /**
   * Every stream actually read, newest contract first. `companion` is this
   * process's tenant-pinned store; `fleet_system` is the shared-schema stream
   * the gateway writes its system-owned observations into, present only when a
   * fleet deployment wired it.
   */
  streams: readonly IncidentTimelineStream[];
  /** Lookback applied, from the owner file. */
  windowMs: number;
}

/** One persisted stream this snapshot was assembled from. */
type IncidentTimelineStream = 'companion' | 'fleet_system';

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
  /**
   * The fleet's system-owned stream, read-only, present only in fleet mode
   * (bead psfn-framework-e5r0s). Absent in a single-companion deployment, where
   * `readStream` already resolves to the table the gateway writes.
   */
  fleetSystemReadStream?: IncidentStreamRead;
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
    const query = {
      sinceMs: Math.max(0, nowMs - config.incidentWindowMs),
      limit: config.incidentScanLimit,
    };
    // Each stream is bounded by the SAME owner-file scan limit rather than the
    // two sharing one: a fleet incident must not be able to push this
    // companion's own incidents out of its window, and vice versa.
    const [companionRows, fleetRows] = await Promise.all([
      this.options.readStream(query),
      this.options.fleetSystemReadStream?.(query) ?? Promise.resolve([]),
    ]);
    const streams: IncidentTimelineStream[] = this.options.fleetSystemReadStream
      ? ['companion', 'fleet_system']
      : ['companion'];
    return {
      generatedAt: nowMs,
      scope: {
        owner: this.owner,
        process: 'agent',
        streams,
        windowMs: config.incidentWindowMs,
      },
      incidents: summarizeIncidents(this.visibleRows([...companionRows, ...fleetRows]), {
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
