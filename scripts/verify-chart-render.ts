#!/usr/bin/env node
// ── Helm chart render verification (psfn-framework-bmftu) ──
// Renders deploy/helm/psfn with `helm template` and asserts the Satellite Hub
// Eidoverse visitor path is wired exactly the way apps/satellite-hub reads it:
//
//   * disabled by default — no EIDOVERSE key reaches any rendered object;
//   * enabled — the satellite-hub container carries EXACTLY the EIDOVERSE_*
//     environment that loadEidoverseMcpConfig()/loadHubConfig() read, with the
//     join token delivered by secretKeyRef under the configured tokenRef name;
//   * partial or contradictory configuration fails rendering closed.
//
// Requires the `helm` binary. Run it with: npm run verify:chart-render

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { isRecord } from '../src/shared/utils/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART_DIR = join(REPO_ROOT, 'deploy', 'helm', 'psfn');
const RELEASE_NAME = 'psfn';

export interface RenderedEnvEntry {
  value?: string;
  secretKeyRef?: { name: string; key: string };
}

/**
 * Extract one container's environment from a rendered multi-document manifest,
 * keyed by environment variable name. Exported so the render contract can be
 * asserted against a fixture without a helm binary.
 */
export function extractContainerEnv(
  manifest: string,
  deploymentName: string,
  containerName: string,
): Map<string, RenderedEnvEntry> {
  const container = findContainer(manifest, deploymentName, containerName);
  if (!container) {
    throw new Error(`rendered manifest has no container ${containerName} in Deployment ${deploymentName}`);
  }
  const env = new Map<string, RenderedEnvEntry>();
  const entries = Array.isArray(container.env) ? container.env : [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue;
    const secretRef = isRecord(entry.valueFrom) && isRecord(entry.valueFrom.secretKeyRef)
      ? entry.valueFrom.secretKeyRef
      : undefined;
    env.set(entry.name, {
      ...(typeof entry.value === 'string' ? { value: entry.value } : {}),
      ...(secretRef && typeof secretRef.name === 'string' && typeof secretRef.key === 'string'
        ? { secretKeyRef: { name: secretRef.name, key: secretRef.key } }
        : {}),
    });
  }
  return env;
}

export function findContainer(
  manifest: string,
  deploymentName: string,
  containerName: string,
): Record<string, unknown> | undefined {
  for (const object of parseManifest(manifest)) {
    if (object.kind !== 'Deployment') continue;
    const metadata = isRecord(object.metadata) ? object.metadata : undefined;
    if (metadata?.name !== deploymentName) continue;
    const spec = isRecord(object.spec) ? object.spec : undefined;
    const template = isRecord(spec?.template) ? spec.template : undefined;
    const podSpec = isRecord(template?.spec) ? template.spec : undefined;
    const containers = Array.isArray(podSpec?.containers) ? podSpec.containers : [];
    for (const candidate of containers) {
      if (isRecord(candidate) && candidate.name === containerName) return candidate;
    }
  }
  return undefined;
}

export function parseManifest(manifest: string): Record<string, unknown>[] {
  return parseAllDocuments(manifest, { maxAliasCount: 0, prettyErrors: true })
    .map(document => document.toJS() as unknown)
    .filter((value): value is Record<string, unknown> => isRecord(value));
}

export function findObject(
  manifest: string,
  kind: string,
  name: string,
): Record<string, unknown> | undefined {
  return parseManifest(manifest).find(object =>
    object.kind === kind && isRecord(object.metadata) && object.metadata.name === name);
}

interface HelmResult {
  status: number;
  stdout: string;
  stderr: string;
}

function helmTemplate(valuesFiles: string[]): HelmResult {
  const args = ['template', RELEASE_NAME, CHART_DIR];
  for (const file of valuesFiles) args.push('-f', file);
  const result = spawnSync('helm', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error('helm is required to verify the chart render; install helm and retry.');
    }
    throw result.error;
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const failures: string[] = [];
const passes: string[] = [];

function check(condition: boolean, description: string, detail = ''): void {
  if (condition) {
    passes.push(description);
    return;
  }
  failures.push(detail ? `${description}\n    ${detail}` : description);
}

function checkEnv(
  env: Map<string, RenderedEnvEntry>,
  name: string,
  expected: string,
): void {
  const actual = env.get(name)?.value;
  check(actual === expected, `satellite-hub env ${name}=${expected}`, `rendered: ${String(actual)}`);
}

function baseValues(): Record<string, unknown> {
  return {
    satelliteHub: {
      enabled: true,
      textOnly: true,
      image: { repository: 'localhost/psfn-satellite-hub', tag: '0.1.0-verify-000000000000' },
      identity: {
        satelliteId: 'hub-example',
        endpointId: 'endpoint-example',
        claimType: 'satellite.endpoint',
      },
    },
    secrets: { values: { satelliteHubApiKey: '0123456789abcdef0123' } },
  };
}

function enabledValues(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    satelliteHub: {
      ...(baseValues().satelliteHub as Record<string, unknown>),
      eidoverse: {
        enabled: true,
        command: '/usr/local/bin/eidoverse-mcp',
        args: ['--stdio', '--quiet'],
        worldUrl: 'wss://world.example.net/socket',
        worldName: 'demo-world',
        agentName: 'companion',
        egressCIDRs: ['192.0.2.30/32'],
        egressPort: 443,
        placeMap: {
          enabled: true,
          mountPath: '/app/config/eidoverse-place-map.json',
          worlds: {
            'demo-world': {
              placeId: 'eidoverse:demo-world',
              regions: { market: 'eidoverse:demo-world:market' },
            },
          },
        },
        ...overrides,
      },
    },
    secrets: {
      values: {
        satelliteHubApiKey: '0123456789abcdef0123',
        eidoverseJoinToken: 'example-join-token',
      },
    },
  };
}

function deepMergeEidoverse(overrides: Record<string, unknown>): Record<string, unknown> {
  const values = enabledValues();
  const hub = values.satelliteHub as Record<string, unknown>;
  hub.eidoverse = { ...(hub.eidoverse as Record<string, unknown>), ...overrides };
  return values;
}

function main(): number {
  const scratch = mkdtempSync(join(tmpdir(), 'psfn-verify-helm-chart-'));
  try {
    const write = (name: string, values: unknown): string => {
      const path = join(scratch, `${name}.json`);
      writeFileSync(path, JSON.stringify(values, null, 2), 'utf8');
      return path;
    };

    // ── Disabled default ──
    const disabled = helmTemplate([write('disabled', baseValues())]);
    check(disabled.status === 0, 'render succeeds with the eidoverse defaults', disabled.stderr.trim());
    check(
      !disabled.stdout.includes('EIDOVERSE') && !disabled.stdout.includes('eidoverse'),
      'disabled render contains no eidoverse key in any object',
    );

    // ── Enabled with the place map ──
    const enabled = helmTemplate([write('enabled', enabledValues())]);
    check(enabled.status === 0, 'render succeeds with the eidoverse visitor path enabled', enabled.stderr.trim());
    if (enabled.status === 0) {
      const env = extractContainerEnv(enabled.stdout, `${RELEASE_NAME}-satellite-hub`, 'satellite-hub');
      const rendered = [...env.keys()].filter(name => name.startsWith('EIDOVERSE')).sort();
      // The exact set apps/satellite-hub reads: loadEidoverseMcpConfig() plus
      // the place-map path and the dereferenced join-token name.
      const expected = [
        'EIDOVERSE_BODY_MAX_PENDING_NOTES',
        'EIDOVERSE_BODY_WALK_TIMEOUT_MS',
        'EIDOVERSE_JOIN_TOKEN',
        'EIDOVERSE_MCP_AGENT_NAME',
        'EIDOVERSE_MCP_AMBIENT_SAY_DEBOUNCE_MS',
        'EIDOVERSE_MCP_ARGS_JSON',
        'EIDOVERSE_MCP_COMMAND',
        'EIDOVERSE_MCP_ENABLED',
        'EIDOVERSE_MCP_PENDING_PINGS_POLL_INTERVAL_MS',
        'EIDOVERSE_MCP_RECONNECT_BASE_MS',
        'EIDOVERSE_MCP_RECONNECT_MAX_ATTEMPTS',
        'EIDOVERSE_MCP_RECONNECT_MAX_MS',
        'EIDOVERSE_MCP_REQUEST_TIMEOUT_MS',
        'EIDOVERSE_MCP_TOKEN_REF',
        'EIDOVERSE_MCP_TRANSPORT',
        'EIDOVERSE_MCP_WORLD_NAME',
        'EIDOVERSE_MCP_WORLD_URL',
        'EIDOVERSE_PLACE_MAP_PATH',
      ];
      check(
        rendered.join(',') === expected.join(','),
        'enabled render carries exactly the eidoverse environment the hub reads',
        `rendered: ${rendered.join(',')}`,
      );
      checkEnv(env, 'EIDOVERSE_MCP_ENABLED', 'true');
      checkEnv(env, 'EIDOVERSE_MCP_TRANSPORT', 'poll');
      checkEnv(env, 'EIDOVERSE_MCP_COMMAND', '/usr/local/bin/eidoverse-mcp');
      checkEnv(env, 'EIDOVERSE_MCP_ARGS_JSON', '["--stdio","--quiet"]');
      checkEnv(env, 'EIDOVERSE_MCP_WORLD_URL', 'wss://world.example.net/socket');
      checkEnv(env, 'EIDOVERSE_MCP_WORLD_NAME', 'demo-world');
      checkEnv(env, 'EIDOVERSE_MCP_AGENT_NAME', 'companion');
      checkEnv(env, 'EIDOVERSE_MCP_TOKEN_REF', 'EIDOVERSE_JOIN_TOKEN');
      checkEnv(env, 'EIDOVERSE_MCP_RECONNECT_BASE_MS', '250');
      checkEnv(env, 'EIDOVERSE_MCP_RECONNECT_MAX_MS', '5000');
      checkEnv(env, 'EIDOVERSE_MCP_RECONNECT_MAX_ATTEMPTS', '3');
      checkEnv(env, 'EIDOVERSE_MCP_REQUEST_TIMEOUT_MS', '10000');
      checkEnv(env, 'EIDOVERSE_MCP_PENDING_PINGS_POLL_INTERVAL_MS', '2000');
      checkEnv(env, 'EIDOVERSE_MCP_AMBIENT_SAY_DEBOUNCE_MS', '180000');
      checkEnv(env, 'EIDOVERSE_BODY_WALK_TIMEOUT_MS', '95000');
      checkEnv(env, 'EIDOVERSE_BODY_MAX_PENDING_NOTES', '4');
      checkEnv(env, 'EIDOVERSE_PLACE_MAP_PATH', '/app/config/eidoverse-place-map.json');
      check(
        !enabled.stdout.includes('EIDOVERSE_SNAPSHOT'),
        'first-person vision renders nothing until it is explicitly enabled',
      );

      const token = env.get('EIDOVERSE_JOIN_TOKEN');
      check(
        token?.value === undefined && token?.secretKeyRef?.key === 'EIDOVERSE_JOIN_TOKEN',
        'the join token is delivered only by secretKeyRef under the configured tokenRef',
        JSON.stringify(token),
      );

      const placeMap = findObject(enabled.stdout, 'ConfigMap', `${RELEASE_NAME}-eidoverse-place-map`);
      const placeMapData = isRecord(placeMap?.data) ? placeMap.data : undefined;
      const placeMapJson = typeof placeMapData?.['eidoverse-place-map.json'] === 'string'
        ? JSON.parse(placeMapData['eidoverse-place-map.json']) as Record<string, unknown>
        : undefined;
      check(
        placeMapJson?.schemaVersion === 1 && isRecord(placeMapJson.worlds)
          && isRecord(placeMapJson.worlds['demo-world']),
        'the place-map ConfigMap renders a schemaVersion 1 world table',
        JSON.stringify(placeMapJson),
      );

      const container = findContainer(enabled.stdout, `${RELEASE_NAME}-satellite-hub`, 'satellite-hub');
      const mounts = Array.isArray(container?.volumeMounts) ? container.volumeMounts : [];
      check(
        mounts.some(mount => isRecord(mount)
          && mount.name === 'eidoverse-place-map'
          && mount.mountPath === '/app/config/eidoverse-place-map.json'
          && mount.subPath === 'eidoverse-place-map.json'
          && mount.readOnly === true),
        'the place map is mounted read-only at the configured path',
      );

      const policy = findObject(enabled.stdout, 'NetworkPolicy', `${RELEASE_NAME}-satellite-hub`);
      check(
        JSON.stringify(policy ?? {}).includes('192.0.2.30/32'),
        'the hub NetworkPolicy opens egress to the configured Eidoverse world CIDR',
      );
    }

    // ── Enabled on the MCPL door transport ──
    // The MCPL render must carry the door's own keys and NONE of the stdio
    // transport's: a rendered EIDOVERSE_MCP_COMMAND under transport: mcpl would
    // describe a stdio server the hub never spawns.
    const mcpl = helmTemplate([write('mcpl', deepMergeEidoverse({
      transport: 'mcpl',
      command: '',
      args: [],
      worldUrl: '',
      mcpl: {
        doorUrl: 'wss://world.example.net/mcpl',
        featureSets: ['eidoverse.world', 'eidoverse.embodiment', 'eidoverse.travel'],
        catchupWake: false,
        handshakeTimeoutMs: 10000,
        wakeQueueLimit: 4,
      },
    }))]);
    check(mcpl.status === 0, 'render succeeds on the MCPL door transport', mcpl.stderr.trim());
    if (mcpl.status === 0) {
      const env = extractContainerEnv(mcpl.stdout, `${RELEASE_NAME}-satellite-hub`, 'satellite-hub');
      const rendered = [...env.keys()].filter(name => name.startsWith('EIDOVERSE')).sort();
      // The body runner works on either transport, so its bounds render here
      // too. Snapshot is disabled in this case, so none of its keys appear;
      // the mcpl-snapshot cases below cover it enabled.
      const expected = [
        'EIDOVERSE_BODY_MAX_PENDING_NOTES',
        'EIDOVERSE_BODY_WALK_TIMEOUT_MS',
        'EIDOVERSE_JOIN_TOKEN',
        'EIDOVERSE_MCPL_CATCHUP_WAKE',
        'EIDOVERSE_MCPL_DOOR_URL',
        'EIDOVERSE_MCPL_FEATURE_SETS_JSON',
        'EIDOVERSE_MCPL_HANDSHAKE_TIMEOUT_MS',
        'EIDOVERSE_MCPL_WAKE_QUEUE_LIMIT',
        'EIDOVERSE_MCP_AGENT_NAME',
        'EIDOVERSE_MCP_AMBIENT_SAY_DEBOUNCE_MS',
        'EIDOVERSE_MCP_ENABLED',
        'EIDOVERSE_MCP_RECONNECT_BASE_MS',
        'EIDOVERSE_MCP_RECONNECT_MAX_ATTEMPTS',
        'EIDOVERSE_MCP_RECONNECT_MAX_MS',
        'EIDOVERSE_MCP_REQUEST_TIMEOUT_MS',
        'EIDOVERSE_MCP_TOKEN_REF',
        'EIDOVERSE_MCP_TRANSPORT',
        'EIDOVERSE_MCP_WORLD_NAME',
        'EIDOVERSE_PLACE_MAP_PATH',
      ];
      check(
        rendered.join(',') === expected.join(','),
        'the MCPL render carries the door environment and no stdio transport keys',
        `rendered: ${rendered.join(',')}`,
      );
      checkEnv(env, 'EIDOVERSE_MCP_TRANSPORT', 'mcpl');
      checkEnv(env, 'EIDOVERSE_MCPL_DOOR_URL', 'wss://world.example.net/mcpl');
      checkEnv(
        env,
        'EIDOVERSE_MCPL_FEATURE_SETS_JSON',
        '["eidoverse.world","eidoverse.embodiment","eidoverse.travel"]',
      );
      checkEnv(env, 'EIDOVERSE_MCPL_CATCHUP_WAKE', 'false');
      checkEnv(env, 'EIDOVERSE_MCPL_HANDSHAKE_TIMEOUT_MS', '10000');
      checkEnv(env, 'EIDOVERSE_MCPL_WAKE_QUEUE_LIMIT', '4');
    }

    const mcplNoDoor = helmTemplate([write('mcpl-no-door', deepMergeEidoverse({
      transport: 'mcpl',
      command: '',
      args: [],
      worldUrl: '',
      mcpl: {
        doorUrl: '',
        featureSets: ['eidoverse.world'],
        catchupWake: false,
        handshakeTimeoutMs: 10000,
        wakeQueueLimit: 4,
      },
    }))]);
    check(mcplNoDoor.status !== 0, 'render fails closed: MCPL transport without a door URL');

    const mcplTokenInDoorUrl = helmTemplate([write('mcpl-token-url', deepMergeEidoverse({
      transport: 'mcpl',
      command: '',
      args: [],
      worldUrl: '',
      mcpl: {
        doorUrl: 'wss://world.example.net/mcpl?token=example',
        featureSets: ['eidoverse.world'],
        catchupWake: false,
        handshakeTimeoutMs: 10000,
        wakeQueueLimit: 4,
      },
    }))]);
    check(
      mcplTokenInDoorUrl.status !== 0,
      'render fails closed: a door URL carrying its own query string',
    );

    // ── Snapshot on the MCPL door ──
    // The hub derives the renderer origin from doorUrl across the conventional
    // /mcpl door path, so that case renders with no explicit origin at all.
    const mcplSnapshot = helmTemplate([write('mcpl-snapshot', deepMergeEidoverse({
      transport: 'mcpl',
      command: '',
      args: [],
      worldUrl: '',
      mcpl: {
        doorUrl: 'wss://world.example.net/mcpl',
        featureSets: ['eidoverse.world'],
        catchupWake: false,
        handshakeTimeoutMs: 10000,
        wakeQueueLimit: 4,
      },
      snapshot: { enabled: true, baseUrl: '', timeoutMs: 4000, maxBytes: 4000000 },
    }))]);
    check(
      mcplSnapshot.status === 0,
      'render succeeds: snapshot on an MCPL door whose origin the hub can derive',
      mcplSnapshot.stderr.trim(),
    );
    if (mcplSnapshot.status === 0) {
      const env = extractContainerEnv(mcplSnapshot.stdout, `${RELEASE_NAME}-satellite-hub`, 'satellite-hub');
      checkEnv(env, 'EIDOVERSE_SNAPSHOT_ENABLED', 'true');
      checkEnv(env, 'EIDOVERSE_SNAPSHOT_TIMEOUT_MS', '4000');
      checkEnv(env, 'EIDOVERSE_SNAPSHOT_MAX_BYTES', '4000000');
      check(
        !env.has('EIDOVERSE_SNAPSHOT_BASE_URL'),
        'an empty snapshot baseUrl leaves the hub to derive it from the door URL',
      );
      checkEnv(env, 'EIDOVERSE_MCPL_DOOR_URL', 'wss://world.example.net/mcpl');
    }

    // A door at any other path is not evidence about where /snap answers, so
    // the deployment must name the renderer origin itself.
    const mcplGatewaySnapshot = helmTemplate([write('mcpl-gateway-snapshot', deepMergeEidoverse({
      transport: 'mcpl',
      command: '',
      args: [],
      worldUrl: '',
      mcpl: {
        doorUrl: 'wss://gateway.example.net/tenants/acme/socket',
        featureSets: ['eidoverse.world'],
        catchupWake: false,
        handshakeTimeoutMs: 10000,
        wakeQueueLimit: 4,
      },
      snapshot: {
        enabled: true,
        baseUrl: 'https://renderer.example.net/commons',
        timeoutMs: 4000,
        maxBytes: 4000000,
      },
    }))]);
    check(
      mcplGatewaySnapshot.status === 0,
      'render succeeds: an explicit origin satisfies snapshot behind a path-routed door',
      mcplGatewaySnapshot.stderr.trim(),
    );
    if (mcplGatewaySnapshot.status === 0) {
      const env = extractContainerEnv(
        mcplGatewaySnapshot.stdout,
        `${RELEASE_NAME}-satellite-hub`,
        'satellite-hub',
      );
      checkEnv(env, 'EIDOVERSE_SNAPSHOT_BASE_URL', 'https://renderer.example.net/commons');
    }

    const mcplUnderivableSnapshot = helmTemplate([write('mcpl-underivable-snapshot', deepMergeEidoverse({
      transport: 'mcpl',
      command: '',
      args: [],
      worldUrl: '',
      mcpl: {
        doorUrl: 'wss://gateway.example.net/tenants/acme/socket',
        featureSets: ['eidoverse.world'],
        catchupWake: false,
        handshakeTimeoutMs: 10000,
        wakeQueueLimit: 4,
      },
      snapshot: { enabled: true, baseUrl: '', timeoutMs: 4000, maxBytes: 4000000 },
    }))]);
    check(
      mcplUnderivableSnapshot.status !== 0
        && mcplUnderivableSnapshot.stderr.includes('satelliteHub.eidoverse.snapshot.baseUrl is required'),
      'render fails closed: snapshot on an MCPL door whose origin cannot be derived',
      mcplUnderivableSnapshot.stderr.trim(),
    );

    // ── Enabled without the place map ──
    const noPlaceMap = helmTemplate([write('no-place-map', deepMergeEidoverse({
      placeMap: { enabled: false, mountPath: '/app/config/eidoverse-place-map.json', worlds: {} },
    }))]);
    check(noPlaceMap.status === 0, 'render succeeds with the place map disabled', noPlaceMap.stderr.trim());
    if (noPlaceMap.status === 0) {
      check(
        !noPlaceMap.stdout.includes('EIDOVERSE_PLACE_MAP_PATH')
          && findObject(noPlaceMap.stdout, 'ConfigMap', `${RELEASE_NAME}-eidoverse-place-map`) === undefined,
        'the place map renders nothing when it is disabled',
      );
    }

    // ── Enabled with first-person vision ──
    const snapshot = helmTemplate([write('snapshot', deepMergeEidoverse({
      snapshot: { enabled: true, baseUrl: '', timeoutMs: 2500, maxBytes: 2000000 },
    }))]);
    check(snapshot.status === 0, 'render succeeds with eidoverse snapshots enabled', snapshot.stderr.trim());
    if (snapshot.status === 0) {
      const env = extractContainerEnv(snapshot.stdout, `${RELEASE_NAME}-satellite-hub`, 'satellite-hub');
      checkEnv(env, 'EIDOVERSE_SNAPSHOT_ENABLED', 'true');
      checkEnv(env, 'EIDOVERSE_SNAPSHOT_TIMEOUT_MS', '2500');
      checkEnv(env, 'EIDOVERSE_SNAPSHOT_MAX_BYTES', '2000000');
      check(
        !env.has('EIDOVERSE_SNAPSHOT_BASE_URL'),
        'an empty snapshot baseUrl leaves the hub to derive it from the world URL',
      );
    }
    const snapshotBaseUrl = helmTemplate([write('snapshot-base-url', deepMergeEidoverse({
      snapshot: {
        enabled: true,
        baseUrl: 'https://snapshots.example.net/world',
        timeoutMs: 4000,
        maxBytes: 4000000,
      },
    }))]);
    if (snapshotBaseUrl.status === 0) {
      const env = extractContainerEnv(snapshotBaseUrl.stdout, `${RELEASE_NAME}-satellite-hub`, 'satellite-hub');
      checkEnv(env, 'EIDOVERSE_SNAPSHOT_BASE_URL', 'https://snapshots.example.net/world');
    }
    check(snapshotBaseUrl.status === 0, 'render succeeds with an explicit snapshot origin', snapshotBaseUrl.stderr.trim());

    // ── Fail-closed negatives ──
    // values.schema.json rejects the shape-level violations before any
    // template runs, so those cases assert the schema path; the rest reach
    // the cross-field checks in templates/validations.yaml.
    const negatives: [string, Record<string, unknown>, string][] = [
      ['missing command', deepMergeEidoverse({ command: '' }), 'satelliteHub.eidoverse.command is required'],
      ['missing worldUrl', deepMergeEidoverse({ worldUrl: '' }), 'satelliteHub.eidoverse.worldUrl is required'],
      ['missing worldName', deepMergeEidoverse({ worldName: '' }), 'satelliteHub.eidoverse.worldName is required'],
      ['missing agentName', deepMergeEidoverse({ agentName: '' }), 'satelliteHub.eidoverse.agentName is required'],
      ['non-websocket worldUrl', deepMergeEidoverse({ worldUrl: 'https://world.example.net' }), "at '/satelliteHub/eidoverse/worldUrl'"],
      ['credential-bearing worldUrl', deepMergeEidoverse({ worldUrl: 'wss://user:pass@world.example.net' }), 'must be credential-free'],
      ['lowercase tokenRef', deepMergeEidoverse({ tokenRef: 'eidoverse_join_token' }), "at '/satelliteHub/eidoverse/tokenRef'"],
      ['tokenRef not backed by a secret key', deepMergeEidoverse({ tokenRef: 'OTHER_JOIN_TOKEN' }), 'must equal secrets.keys.eidoverseJoinToken'],
      ['zero reconnect base', deepMergeEidoverse({ reconnectBaseMs: 0 }), "at '/satelliteHub/eidoverse/reconnectBaseMs': minimum"],
      ['inverted reconnect window', deepMergeEidoverse({ reconnectBaseMs: 9000 }), 'must be >= satelliteHub.eidoverse.reconnectBaseMs'],
      ['out-of-range egress port', deepMergeEidoverse({ egressPort: 70000 }), "at '/satelliteHub/eidoverse/egressPort': maximum"],
      ['zero body walk timeout', deepMergeEidoverse({
        body: { walkTimeoutMs: 0, maxPendingNotes: 4 },
      }), "at '/satelliteHub/eidoverse/body/walkTimeoutMs': minimum"],
      // A zero wake budget would drop every pushed batch, which is silence the
      // operator did not ask for; the hub refuses it too.
      ['zero MCPL wake queue budget', deepMergeEidoverse({
        transport: 'mcpl',
        command: '',
        args: [],
        worldUrl: '',
        mcpl: {
          doorUrl: 'wss://world.example.net/mcpl',
          featureSets: ['eidoverse.world'],
          catchupWake: false,
          handshakeTimeoutMs: 10000,
          wakeQueueLimit: 0,
        },
      }), "at '/satelliteHub/eidoverse/mcpl/wakeQueueLimit': minimum"],
      ['non-http snapshot origin', deepMergeEidoverse({
        snapshot: { enabled: true, baseUrl: 'ws://world.example.net', timeoutMs: 4000, maxBytes: 4000000 },
      }), "at '/satelliteHub/eidoverse/snapshot/baseUrl'"],
      ['credential-bearing snapshot origin', deepMergeEidoverse({
        snapshot: {
          enabled: true,
          baseUrl: 'https://user:pass@snapshots.example.net',
          timeoutMs: 4000,
          maxBytes: 4000000,
        },
      }), 'snapshot.baseUrl must be credential-free'],
      ['zero snapshot size budget', deepMergeEidoverse({
        snapshot: { enabled: true, baseUrl: '', timeoutMs: 4000, maxBytes: 0 },
      }), "at '/satelliteHub/eidoverse/snapshot/maxBytes': minimum"],
      ['empty place map', deepMergeEidoverse({
        placeMap: { enabled: true, mountPath: '/app/config/eidoverse-place-map.json', worlds: {} },
      }), 'must contain at least one world'],
    ];
    for (const [label, values, expectedMessage] of negatives) {
      const result = helmTemplate([write(`negative-${label.replace(/[^a-z0-9]+/giu, '-')}`, values)]);
      check(
        result.status !== 0 && result.stderr.includes(expectedMessage),
        `render fails closed: ${label}`,
        result.status === 0 ? 'rendered successfully' : result.stderr.trim().split('\n').slice(0, 2).join(' '),
      );
    }

    // eidoverse.enabled without satelliteHub.enabled
    const orphaned = helmTemplate([write('orphaned', {
      satelliteHub: { enabled: false, eidoverse: { enabled: true } },
    })]);
    check(
      orphaned.status !== 0 && orphaned.stderr.includes('requires satelliteHub.enabled=true'),
      'render fails closed: eidoverse enabled without the hub',
      orphaned.stderr.trim().split('\n').slice(0, 2).join(' '),
    );

    // placeMap enabled without the visitor path
    const orphanedPlaceMap = helmTemplate([write('orphaned-place-map', {
      satelliteHub: {
        ...(baseValues().satelliteHub as Record<string, unknown>),
        eidoverse: {
          placeMap: {
            enabled: true,
            mountPath: '/app/config/eidoverse-place-map.json',
            worlds: { 'demo-world': { placeId: 'eidoverse:demo-world' } },
          },
        },
      },
      secrets: { values: { satelliteHubApiKey: '0123456789abcdef0123' } },
    })]);
    check(
      orphanedPlaceMap.status !== 0
        && orphanedPlaceMap.stderr.includes('placeMap.enabled=true requires satelliteHub.eidoverse.enabled=true'),
      'render fails closed: place map without the visitor path',
      orphanedPlaceMap.stderr.trim().split('\n').slice(0, 2).join(' '),
    );

    // Schema rejection: an unknown eidoverse key must not be silently ignored.
    const unknownKey = helmTemplate([write('unknown-key', deepMergeEidoverse({ worldUrlTypo: 'wss://x' }))]);
    check(
      unknownKey.status !== 0 && unknownKey.stderr.includes('values don\'t meet the specifications'),
      'render fails closed: unknown satelliteHub.eidoverse key',
      unknownKey.stderr.trim().split('\n').slice(0, 2).join(' '),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  for (const description of passes) console.log(`PASS  ${description}`);
  for (const description of failures) console.error(`FAIL  ${description}`);
  console.log(`${passes.length} passed, ${failures.length} failed`);
  return failures.length === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`verify-helm-chart failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
