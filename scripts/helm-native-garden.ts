import { spawnSync } from 'node:child_process';
import { isRecord } from '../src/shared/utils/types.js';

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => CommandResult;

interface K3dPortBinding {
  HostIp?: unknown;
  HostPort?: unknown;
}

interface K3dNode {
  role?: unknown;
  State?: { Running?: unknown };
  portMappings?: Record<string, unknown>;
}

interface K3dCluster {
  name?: unknown;
  nodes?: unknown;
}

export interface TailnetConnection {
  cli: string;
  dnsName: string;
  windowsHost: boolean;
}

function defaultRun(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): CommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs,
  });
  if (result.error) {
    const code = 'code' in result.error ? String(result.error.code) : '';
    if (code === 'ENOENT') return { status: 127, stdout: '', stderr: result.error.message };
    throw result.error;
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function commandFailure(command: string, args: readonly string[], result: CommandResult): Error {
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  return new Error(`${command} ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`);
}

function runRequired(
  run: CommandRunner,
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): CommandResult {
  const result = run(command, args, options);
  if (result.status !== 0) throw commandFailure(command, args, result);
  return result;
}

export function parseK3dClusters(raw: string): K3dCluster[] {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`k3d returned malformed cluster JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(value)) throw new Error('k3d cluster list must return a JSON array.');
  return value as K3dCluster[];
}

function nativeGardenBinding(cluster: K3dCluster, gardenPort: number): boolean {
  if (!Array.isArray(cluster.nodes)) return false;
  return (cluster.nodes as K3dNode[]).some((node) => {
    if (node.role !== 'server' || !node.portMappings) return false;
    const bindings = node.portMappings['443/tcp'];
    return Array.isArray(bindings) && (bindings as K3dPortBinding[]).some((binding) => (
      binding.HostIp === '127.0.0.1' && binding.HostPort === String(gardenPort)
    ));
  });
}

function clusterRunning(cluster: K3dCluster): boolean {
  if (!Array.isArray(cluster.nodes)) return false;
  const required = (cluster.nodes as K3dNode[]).filter((node) => (
    node.role === 'server' || node.role === 'loadbalancer'
  ));
  return required.length > 0 && required.every((node) => node.State?.Running === true);
}

function assertClusterName(value: string): void {
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u.test(value)) {
    throw new Error(`PSFN_K3D_CLUSTER must be a lowercase Kubernetes label: ${value}`);
  }
}

export function ensureNativeK3dGarden(input: {
  clusterName: string;
  cwd: string;
  gardenPort: number;
  kubeContext: string;
  timeoutMs: number;
  run?: CommandRunner;
}): 'created' | 'existing' {
  const run = input.run ?? defaultRun;
  assertClusterName(input.clusterName);
  if (input.kubeContext !== `k3d-${input.clusterName}`) {
    throw new Error('PSFN_K3D_CLUSTER must name the exact cluster selected by PSFN_KUBE_CONTEXT.');
  }
  const options = { cwd: input.cwd, timeoutMs: input.timeoutMs };
  const list = (): K3dCluster[] => parseK3dClusters(
    runRequired(run, 'k3d', ['cluster', 'list', '--output', 'json'], options).stdout,
  );
  let cluster = list().find((candidate) => candidate.name === input.clusterName);
  let outcome: 'created' | 'existing' = 'existing';
  if (!cluster) {
    runRequired(run, 'k3d', [
      'cluster', 'create', input.clusterName,
      '--servers', '1',
      '--agents', '0',
      '--image', 'rancher/k3s:v1.35.5-k3s1',
      '--wait',
      '--port', `127.0.0.1:${input.gardenPort}:443/tcp@server:0:direct`,
    ], options);
    outcome = 'created';
    cluster = list().find((candidate) => candidate.name === input.clusterName);
  } else {
    if (!nativeGardenBinding(cluster, input.gardenPort)) {
      throw new Error(
        `Existing cluster ${input.clusterName} does not map 127.0.0.1:${input.gardenPort} `
        + 'directly to server 0 Traefik HTTPS. Choose an unused cluster name; existing clusters are never changed automatically.',
      );
    }
    if (!clusterRunning(cluster)) {
      runRequired(run, 'k3d', ['cluster', 'start', input.clusterName, '--wait'], options);
      cluster = list().find((candidate) => candidate.name === input.clusterName);
    }
  }
  if (!cluster) throw new Error(`k3d did not report cluster ${input.clusterName} after creation.`);
  if (!nativeGardenBinding(cluster, input.gardenPort)) {
    throw new Error(
      `Existing cluster ${input.clusterName} does not map 127.0.0.1:${input.gardenPort} `
      + 'directly to server 0 Traefik HTTPS. Choose an unused cluster name; existing clusters are never changed automatically.',
    );
  }
  return outcome;
}

export function parseConnectedTailnetStatus(raw: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Tailscale returned malformed status JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error('Tailscale status must be a JSON object.');
  const status = value as { BackendState?: unknown; Self?: { Online?: unknown; DNSName?: unknown } };
  if (status.BackendState !== 'Running' || status.Self?.Online !== true) return undefined;
  const dnsName = typeof status.Self.DNSName === 'string'
    ? status.Self.DNSName.replace(/\.$/u, '').toLowerCase()
    : '';
  return dnsName.endsWith('.ts.net') ? dnsName : undefined;
}

export function discoverConnectedTailnet(input: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
  timeoutMs?: number;
} = {}): TailnetConnection | undefined {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? process.env;
  const run = input.run ?? defaultRun;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const explicitCli = env.PSFN_TAILSCALE_CLI?.trim();
  if (explicitCli) {
    const result = run(explicitCli, ['status', '--json'], { cwd, timeoutMs });
    if (result.status !== 0) throw commandFailure(explicitCli, ['status'], result);
    const dnsName = parseConnectedTailnetStatus(result.stdout);
    if (!dnsName) throw new Error(`Explicit Tailscale CLI ${explicitCli} is not connected on this node.`);
    return { cli: explicitCli, dnsName, windowsHost: explicitCli.startsWith('/mnt/') };
  }
  const candidates = [
    'tailscale',
    '/mnt/c/Program Files/Tailscale/tailscale.exe',
  ].filter((candidate, index, values): candidate is string => (
    Boolean(candidate) && values.indexOf(candidate) === index
  ));
  for (const cli of candidates) {
    const result = run(cli, ['status', '--json'], { cwd, timeoutMs });
    if (result.status !== 0) continue;
    const dnsName = parseConnectedTailnetStatus(result.stdout);
    if (dnsName) return { cli, dnsName, windowsHost: cli.startsWith('/mnt/') };
  }
  return undefined;
}

export function verifyTokenLoginRedirect(input: {
  curlCommand: string;
  cwd: string;
  headers?: readonly string[];
  insecureLocalTls?: boolean;
  run?: CommandRunner;
  timeoutMs: number;
  url: string;
}): void {
  const run = input.run ?? defaultRun;
  const maxTimeSeconds = String(Math.max(1, Math.ceil(input.timeoutMs / 1_000)));
  const args = [
    '--silent', '--show-error', '--max-time', maxTimeSeconds,
    '--output', '/dev/null',
    '--write-out', '%{http_code}\n%header{location}',
    ...(input.insecureLocalTls ? ['--insecure'] : []),
    ...(input.headers?.flatMap((header) => ['--header', header]) ?? []),
    input.url,
  ];
  const result = run(input.curlCommand, args, { cwd: input.cwd, timeoutMs: input.timeoutMs });
  if (result.status !== 0) throw commandFailure(input.curlCommand, args, result);
  const [status = '', location = ''] = result.stdout.replaceAll('\r', '').trimEnd().split('\n');
  if (status !== '302' || location !== '/login') {
    throw new Error(
      `Garden root must redirect to standalone token login (HTTP ${status || '<none>'}, `
      + `Location: ${location || '<none>'}).`,
    );
  }
}

export function inspectTailnetHttpsRoot(
  raw: string,
  dnsName: string,
  expectedProxy: string,
): 'available' | 'current' {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Tailscale returned malformed Serve status JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error('Tailscale Serve status must be a JSON object.');
  const tcp = value.TCP === undefined ? {} : value.TCP;
  const web = value.Web === undefined ? {} : value.Web;
  if (!isRecord(tcp) || !isRecord(web)) {
    throw new Error('Tailscale Serve status TCP and Web fields must be objects.');
  }
  const web443 = Object.entries(web).filter(([host]) => host.toLowerCase().endsWith(':443'));
  if (tcp['443'] === undefined && web443.length === 0) return 'available';
  const tcp443 = tcp['443'];
  const exactWeb = Object.entries(web).find(([host]) => host.toLowerCase() === `${dnsName.toLowerCase()}:443`)?.[1];
  if (!isRecord(tcp443) || tcp443.HTTPS !== true || !isRecord(exactWeb)) {
    throw new Error('Tailscale HTTPS port 443 already has an operator-owned Serve configuration; refusing to replace it.');
  }
  const handlers = exactWeb.Handlers;
  const root = isRecord(handlers) ? handlers['/'] : undefined;
  if (!isRecord(root) || root.Proxy !== expectedProxy) {
    throw new Error('Tailscale HTTPS root already has an operator-owned Serve configuration; refusing to replace it.');
  }
  return 'current';
}

export function reconcileNativeGardenEdge(input: {
  configureServe?: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  gardenPort: number;
  publishTailnet: boolean;
  run?: CommandRunner;
  tailnetHost?: string;
  timeoutMs: number;
}): string | undefined {
  const run = input.run ?? defaultRun;
  verifyTokenLoginRedirect({
    curlCommand: 'curl',
    cwd: input.cwd,
    insecureLocalTls: true,
    run,
    timeoutMs: input.timeoutMs,
    url: `https://127.0.0.1:${input.gardenPort}/`,
  });
  if (!input.publishTailnet) return undefined;

  const connected = discoverConnectedTailnet({
    cwd: input.cwd,
    env: input.env,
    run,
    timeoutMs: input.timeoutMs,
  });
  if (!connected) throw new Error('Tailscale publication requires Tailscale to be installed and connected on this node.');
  if (!input.tailnetHost || connected.dnsName !== input.tailnetHost.toLowerCase()) {
    throw new Error(
      `Configured Tailnet host ${input.tailnetHost || '<none>'} does not match connected host ${connected.dnsName}.`,
    );
  }
  const options = { cwd: input.cwd, timeoutMs: input.timeoutMs };
  const serveTarget = `https+insecure://127.0.0.1:${input.gardenPort}`;
  const serveStatus = runRequired(
    run,
    connected.cli,
    ['serve', 'status', '--json'],
    options,
  );
  const rootState = inspectTailnetHttpsRoot(serveStatus.stdout, connected.dnsName, serveTarget);
  const curlCommand = connected.windowsHost
    ? '/mnt/c/WINDOWS/System32/curl.exe'
    : 'curl';
  let addedRoot = false;
  try {
    if (input.configureServe !== false && rootState === 'available') {
      addedRoot = true;
      runRequired(run, connected.cli, [
        'serve', '--bg', '--yes', '--https=443', serveTarget,
      ], options);
    }
    verifyTokenLoginRedirect({
      curlCommand,
      cwd: input.cwd,
      headers: ['Accept: text/html,application/xhtml+xml'],
      run,
      timeoutMs: input.timeoutMs,
      url: `https://${connected.dnsName}/`,
    });
  } catch (error) {
    if (addedRoot) {
      const rollback = run(connected.cli, ['serve', '--yes', '--https=443', 'off'], options);
      if (rollback.status !== 0) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; Tailscale Serve rollback also failed: `
          + `${rollback.stderr.trim() || rollback.stdout.trim() || `exit ${rollback.status}`}`,
        );
      }
    }
    throw error;
  }
  return connected.dnsName;
}
