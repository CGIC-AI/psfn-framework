import { describe, expect, it } from 'vitest';
import {
  discoverConnectedTailnet,
  ensureNativeK3dGarden,
  parseConnectedTailnetStatus,
  parseK3dClusters,
  reconcileNativeGardenEdge,
  verifyTokenLoginRedirect,
  type CommandRunner,
  type CommandResult,
} from './helm-native-garden.js';

function result(stdout = '', status = 0, stderr = ''): CommandResult {
  return { status, stdout, stderr };
}

function cluster(name: string, port: number, running = true): string {
  return JSON.stringify([{
    name,
    nodes: [{
      role: 'loadbalancer',
      State: { Running: running },
      portMappings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] },
    }, {
      role: 'server',
      State: { Running: running },
    }],
  }]);
}

describe('native k3d Garden binding', () => {
  it('accepts an existing exact loopback-to-Traefik mapping', () => {
    const calls: string[][] = [];
    const run: CommandRunner = (_command, args) => {
      calls.push([...args]);
      return result(cluster('example-local', 10053));
    };
    expect(ensureNativeK3dGarden({
      clusterName: 'example-local',
      cwd: '/repo',
      gardenPort: 10053,
      kubeContext: 'k3d-example-local',
      timeoutMs: 30_000,
      run,
    })).toBe('existing');
    expect(calls).toEqual([['cluster', 'list', '--output', 'json']]);
  });

  it('creates a missing pinned cluster with the persistent Garden mapping', () => {
    const calls: string[][] = [];
    let created = false;
    const run: CommandRunner = (_command, args) => {
      calls.push([...args]);
      if (args[1] === 'create') {
        created = true;
        return result();
      }
      return result(created ? cluster('example-local', 10053) : '[]');
    };
    expect(ensureNativeK3dGarden({
      clusterName: 'example-local',
      cwd: '/repo',
      gardenPort: 10053,
      kubeContext: 'k3d-example-local',
      timeoutMs: 30_000,
      run,
    })).toBe('created');
    expect(calls[1]).toEqual([
      'cluster', 'create', 'example-local',
      '--servers', '1', '--agents', '0',
      '--image', 'rancher/k3s:v1.35.5-k3s1',
      '--wait', '--port', '127.0.0.1:10053:80/tcp@loadbalancer',
    ]);
  });

  it('never recreates an existing cluster with the wrong mapping', () => {
    const run: CommandRunner = () => result(cluster('example-local', 10054));
    expect(() => ensureNativeK3dGarden({
      clusterName: 'example-local',
      cwd: '/repo',
      gardenPort: 10053,
      kubeContext: 'k3d-example-local',
      timeoutMs: 30_000,
      run,
    })).toThrow(/never recreated automatically/u);
  });

  it('fails closed on malformed cluster inventory', () => {
    expect(() => parseK3dClusters('{}')).toThrow(/JSON array/u);
  });
});

describe('native Tailscale Garden edge', () => {
  const connectedStatus = JSON.stringify({
    BackendState: 'Running',
    Self: { Online: true, DNSName: 'demo-node.example.ts.net.' },
  });

  it('discovers only an online connected Tailnet identity', () => {
    expect(parseConnectedTailnetStatus(connectedStatus)).toBe('demo-node.example.ts.net');
    expect(parseConnectedTailnetStatus(JSON.stringify({
      BackendState: 'Stopped',
      Self: { Online: false, DNSName: 'demo-node.example.ts.net.' },
    }))).toBeUndefined();
    expect(discoverConnectedTailnet({
      cwd: '/repo',
      env: { PSFN_TAILSCALE_CLI: '/opt/tailscale' },
      timeoutMs: 10_000,
      run: () => result(connectedStatus),
    })).toEqual({
      cli: '/opt/tailscale',
      dnsName: 'demo-node.example.ts.net',
      windowsHost: false,
    });
  });

  it('publishes 443 to the native loopback port and verifies exact token login', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const cli = '/mnt/c/Program Files/Tailscale/tailscale.exe';
    const run: CommandRunner = (command, args) => {
      calls.push({ command, args: [...args] });
      if (args[0] === 'status') return result(connectedStatus);
      if (args[0] === 'serve') return result();
      return result('302\n/login');
    };
    expect(reconcileNativeGardenEdge({
      cwd: '/repo',
      env: { PSFN_TAILSCALE_CLI: cli },
      gardenPort: 10053,
      publishTailnet: true,
      run,
      tailnetHost: 'demo-node.example.ts.net',
      timeoutMs: 10_000,
    })).toBe('demo-node.example.ts.net');
    expect(calls).toContainEqual({
      command: cli,
      args: ['serve', '--bg', '--yes', 'http://127.0.0.1:10053'],
    });
    expect(calls.at(-1)?.command).toBe('/mnt/c/WINDOWS/System32/curl.exe');
    expect(calls.at(-1)?.args.at(-1)).toBe('https://demo-node.example.ts.net/');
  });

  it('rejects a configured hostname that is not the connected node', () => {
    const run: CommandRunner = (_command, args) => (
      args[0] === 'status' ? result(connectedStatus) : result('302\n/login')
    );
    expect(() => reconcileNativeGardenEdge({
      cwd: '/repo',
      env: { PSFN_TAILSCALE_CLI: '/opt/tailscale' },
      gardenPort: 10053,
      publishTailnet: true,
      run,
      tailnetHost: 'other-node.example.ts.net',
      timeoutMs: 10_000,
    })).toThrow(/does not match connected host/u);
  });

  it('requires the exact standalone login redirect', () => {
    expect(() => verifyTokenLoginRedirect({
      curlCommand: 'curl',
      cwd: '/repo',
      run: () => result('302\n/v1/fleet-auth/login'),
      timeoutMs: 10_000,
      url: 'http://127.0.0.1:10053/',
    })).toThrow(/standalone token login/u);
  });
});
