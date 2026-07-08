// ── Gateway fleet-status surface (sprint-10 W4) ──
// Thin, read-only cluster health view served by the gateway process: every
// companion in companions.json, up/down from the connection registry,
// last-seen activity, recent multi-companion violation counts, and a link out
// to each companion's own Garden (one Garden per companion — decision log #9).
//
// Deliberately NOT a multi-tenant admin surface: no mutation endpoints, no
// secrets in any payload, no per-companion admin data. Fatigue/charge posture
// is not shown — the gateway has no cheap authority for it today; that is a
// documented follow-up rather than a new telemetry pipe.
//
// Fail-closed posture:
//   - only starts when FLEET_STATUS_PORT is set AND multi-companion is active;
//     FLEET_STATUS_PORT without the topology flag refuses startup.
//   - binds loopback only (default 127.0.0.1); non-loopback hosts are rejected
//     — front it with a reverse proxy/tunnel if remote access is needed.
//   - a taken port rejects startup; the listener never picks another port.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createComponentLogger } from '../../shared/logger.js';
import { sendHtml, sendJson, sendText } from '../../channels/backplane/http/primitives.js';
import { parseOptionalPositiveIntEnv, parseOptionalStringEnv } from '../../shared/utils/env.js';
import { MULTI_COMPANION_ENV_VAR, type CompanionFleetEntry } from '../../system/config/companions-config.js';
import type { GatewayFleetConnectionSnapshot } from './server.js';

const log = createComponentLogger('GatewayFleetStatus');

export const FLEET_STATUS_PORT_ENV = 'FLEET_STATUS_PORT';
export const FLEET_STATUS_HOST_ENV = 'FLEET_STATUS_HOST';
const DEFAULT_FLEET_STATUS_HOST = '127.0.0.1';

/** The gateway-side live source: implemented by GatewayServer. */
export interface FleetConnectionSnapshotSource {
  getFleetConnectionSnapshot(): GatewayFleetConnectionSnapshot;
}

export interface FleetStatusCompanionPayload {
  companionId: string;
  /** True when the companion currently holds an identified gateway connection. */
  up: boolean;
  /** Connection registry state, or "down" when no connection is bound. */
  state: 'registering' | 'ready' | 'degraded' | 'down';
  health?: 'healthy' | 'stale' | 'failed';
  stateReason?: string;
  connectedAt?: string;
  /** Last observed activity (RPC traffic), retained across disconnects. */
  lastSeenAt?: string;
  /** Multi-companion violation alarms attributed to this companion in the window. */
  recentViolationCount: number;
  /** Port of this companion's own Garden operator surface, when configured. */
  gardenPort?: number;
}

export interface FleetStatusPayload {
  generatedAt: string;
  companionCount: number;
  upCount: number;
  companions: FleetStatusCompanionPayload[];
  unattributedRecentViolationCount: number;
  recentViolationWindowMs: number;
}

export interface FleetStatusServerOptions {
  host?: string;
  port: number;
  fleet: readonly Pick<CompanionFleetEntry, 'companionId' | 'gardenPort'>[];
  source: FleetConnectionSnapshotSource;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]'
    || normalized.startsWith('127.');
}

export function buildFleetStatusPayload(
  fleet: readonly Pick<CompanionFleetEntry, 'companionId' | 'gardenPort'>[],
  snapshot: GatewayFleetConnectionSnapshot,
): FleetStatusPayload {
  const connectionsById = new Map(
    snapshot.connections.map((connection) => [connection.companionId, connection]),
  );

  const companions: FleetStatusCompanionPayload[] = fleet.map((entry) => {
    const connection = connectionsById.get(entry.companionId);
    // Never-seen companions have no last-seen record at all.
    const lastSeen = connection?.lastSeenAt
      ?? (Object.hasOwn(snapshot.lastSeenByCompanionId, entry.companionId)
        ? snapshot.lastSeenByCompanionId[entry.companionId]
        : undefined);
    return {
      companionId: entry.companionId,
      up: connection !== undefined,
      state: connection?.state ?? 'down',
      ...(connection ? { health: connection.health } : {}),
      ...(connection ? { stateReason: connection.stateReason } : {}),
      ...(connection ? { connectedAt: new Date(connection.connectedAt).toISOString() } : {}),
      ...(lastSeen !== undefined ? { lastSeenAt: new Date(lastSeen).toISOString() } : {}),
      recentViolationCount: snapshot.recentViolationsByCompanionId[entry.companionId] ?? 0,
      ...(entry.gardenPort !== undefined ? { gardenPort: entry.gardenPort } : {}),
    };
  });

  return {
    generatedAt: new Date(snapshot.generatedAt).toISOString(),
    companionCount: companions.length,
    upCount: companions.filter((companion) => companion.up).length,
    companions,
    unattributedRecentViolationCount: snapshot.unattributedRecentViolationCount,
    recentViolationWindowMs: snapshot.recentViolationWindowMs,
  };
}

export class FleetStatusServer {
  private readonly server: Server;
  private readonly host: string;

  constructor(private readonly options: FleetStatusServerOptions) {
    this.host = options.host ?? DEFAULT_FLEET_STATUS_HOST;
    if (!isLoopbackHost(this.host)) {
      throw new Error(
        `${FLEET_STATUS_HOST_ENV}="${this.host}" is not a loopback address. The fleet-status `
        + 'listener is loopback-only; front it with a reverse proxy or tunnel for remote access.',
      );
    }
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        // Fail closed: a taken port (or any bind failure) refuses startup.
        // Never silently pick another port.
        reject(new Error(
          `Fleet-status listener failed to bind ${this.host}:${this.options.port}: `
          + `${error.code ?? error.message}`,
        ));
      };
      this.server.once('error', onError);
      this.server.listen(this.options.port, this.host, () => {
        this.server.off('error', onError);
        log.info('Fleet-status surface listening', {
          host: this.host,
          port: this.boundPort(),
          companions: this.options.fleet.length,
        });
        resolve();
      });
    });
  }

  /** Actual bound port (differs from options.port only when 0 was requested in tests). */
  boundPort(): number {
    const address = this.server.address();
    if (address && typeof address === 'object') {
      return (address as AddressInfo).port;
    }
    return this.options.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.closeAllConnections();
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method !== 'GET') {
      sendText(res, 405, 'Method Not Allowed', { Allow: 'GET' });
      return;
    }
    if (path === '/fleet/status.json') {
      sendJson(res, 200, buildFleetStatusPayload(
        this.options.fleet,
        this.options.source.getFleetConnectionSnapshot(),
      ));
      return;
    }
    if (path === '/' || path === '/fleet') {
      sendHtml(res, 200, FLEET_STATUS_PAGE_HTML);
      return;
    }
    sendText(res, 404, `Not found: ${path}`);
  }
}

export interface StartOptionalFleetStatusServerOptions {
  env?: NodeJS.ProcessEnv;
  multiCompanion: boolean;
  fleet?: readonly Pick<CompanionFleetEntry, 'companionId' | 'gardenPort'>[];
  source: FleetConnectionSnapshotSource;
}

/**
 * Start the fleet-status listener when FLEET_STATUS_PORT is configured.
 * Absent env => no listener (single-companion behavior byte-identical).
 * Present env without multi-companion topology => refuse startup.
 */
export async function startOptionalFleetStatusServer(
  options: StartOptionalFleetStatusServerOptions,
): Promise<FleetStatusServer | undefined> {
  const env = options.env ?? process.env;
  const port = parseOptionalPositiveIntEnv(env[FLEET_STATUS_PORT_ENV]);
  if (port === undefined) {
    if (parseOptionalStringEnv(env[FLEET_STATUS_PORT_ENV])) {
      throw new Error(
        `Invalid ${FLEET_STATUS_PORT_ENV}=${JSON.stringify(env[FLEET_STATUS_PORT_ENV])}; `
        + 'expected a positive integer port',
      );
    }
    return undefined;
  }

  if (!options.multiCompanion || !options.fleet) {
    throw new Error(
      `${FLEET_STATUS_PORT_ENV} is set but ${MULTI_COMPANION_ENV_VAR} is not enabled `
      + '(or no fleet manifest resolved). The fleet-status surface is a multi-companion '
      + 'cluster view; unset the port or enable the topology.',
    );
  }

  const server = new FleetStatusServer({
    ...(parseOptionalStringEnv(env[FLEET_STATUS_HOST_ENV])
      ? { host: parseOptionalStringEnv(env[FLEET_STATUS_HOST_ENV]) }
      : {}),
    port,
    fleet: options.fleet,
    source: options.source,
  });
  await server.start();
  return server;
}

// Self-contained page: no external assets, no secrets, garden links are built
// client-side from the page's own hostname + each companion's gardenPort.
const FLEET_STATUS_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PSFN Fleet Status</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  .meta { color: #888; font-size: 0.85rem; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #8884; padding: 0.5rem 0.75rem; text-align: left; font-size: 0.9rem; }
  th { font-weight: 600; }
  .state { font-weight: 600; }
  .state.ready { color: #2e9e44; }
  .state.registering { color: #b58a00; }
  .state.degraded { color: #c96a11; }
  .state.down { color: #c0392b; }
  .violations-warn { color: #c0392b; font-weight: 600; }
  code { font-size: 0.85em; }
  .err { color: #c0392b; }
</style>
</head>
<body>
<h1>PSFN Fleet Status</h1>
<div class="meta" id="meta">Loading…</div>
<table>
  <thead>
    <tr>
      <th>Companion</th><th>State</th><th>Health</th><th>Last seen</th>
      <th>Connected since</th><th>Recent violations</th><th>Garden</th>
    </tr>
  </thead>
  <tbody id="rows"></tbody>
</table>
<script>
(function () {
  'use strict';
  var meta = document.getElementById('meta');
  var rows = document.getElementById('rows');
  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return '&#' + c.charCodeAt(0) + ';';
    });
  }
  function fmt(iso) {
    return iso ? new Date(iso).toLocaleString() : '—';
  }
  function render(payload) {
    meta.textContent = payload.upCount + '/' + payload.companionCount
      + ' companions up · generated ' + fmt(payload.generatedAt)
      + (payload.unattributedRecentViolationCount > 0
        ? ' · ' + payload.unattributedRecentViolationCount + ' unattributed violation(s) in window'
        : '');
    rows.innerHTML = payload.companions.map(function (c) {
      var garden = c.gardenPort
        ? '<a href="http://' + esc(location.hostname) + ':' + esc(c.gardenPort) + '/garden">:' + esc(c.gardenPort) + '</a>'
        : '—';
      var violations = c.recentViolationCount > 0
        ? '<span class="violations-warn">' + esc(c.recentViolationCount) + '</span>'
        : '0';
      return '<tr>'
        + '<td><code>' + esc(c.companionId) + '</code></td>'
        + '<td class="state ' + esc(c.state) + '">' + esc(c.state) + '</td>'
        + '<td>' + esc(c.health || '—') + '</td>'
        + '<td>' + esc(fmt(c.lastSeenAt)) + '</td>'
        + '<td>' + esc(fmt(c.connectedAt)) + '</td>'
        + '<td>' + violations + '</td>'
        + '<td>' + garden + '</td>'
        + '</tr>';
    }).join('');
  }
  function refresh() {
    fetch('/fleet/status.json').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(render).catch(function (error) {
      meta.innerHTML = '<span class="err">Failed to load fleet status: ' + esc(error.message) + '</span>';
    });
  }
  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>
`;
