import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { describe, expect, it } from 'vitest';
import { isRecord } from '../../../shared/utils/types.js';

interface SecretKeyRefEnv {
  name: string;
  valueFrom?: {
    secretKeyRef?: {
      key?: string;
      name?: string;
      optional?: boolean;
    };
  };
  value?: string;
}

interface DeploymentContainer {
  env?: SecretKeyRefEnv[];
  name?: string;
  readinessProbe?: {
    exec?: { command?: string[] };
    tcpSocket?: unknown;
  };
  volumeMounts?: Array<{
    mountPath?: string;
    name?: string;
    readOnly?: boolean;
  }>;
}

interface DeploymentResource {
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    template?: {
      spec?: {
        containers?: DeploymentContainer[];
      };
    };
  };
}

interface CertificateResource {
  kind?: string;
  metadata?: { name?: string };
  spec?: { usages?: string[] };
}

const renderedResources = parseAllDocuments(execFileSync(
  'helm',
  ['template', 'psfn', join(process.cwd(), 'deploy', 'helm', 'psfn'), '--namespace', 'psfn-test'],
  { encoding: 'utf8' },
)).map(document => document.toJS() as unknown);

function containerEnv(component: 'agent' | 'garden' | 'gateway'): SecretKeyRefEnv[] {
  const deploymentName = component === 'agent'
    ? 'psfn-agent-11111111-1111-4111-8111-111111111111'
    : `psfn-${component}`;
  const deployment = renderedResources.find((resource): resource is DeploymentResource => (
    isRecord(resource)
    && resource.kind === 'Deployment'
    && isRecord(resource.metadata)
    && resource.metadata.name === deploymentName
  ));
  if (!deployment) {
    throw new Error(`Missing rendered Helm Deployment ${deploymentName}`);
  }
  const container = deployment.spec?.template?.spec?.containers
    ?.find(candidate => candidate.name === component);
  if (!container) {
    throw new Error(`Missing rendered ${component} container in ${deploymentName}`);
  }
  return container.env ?? [];
}

function agentContainer(): DeploymentContainer {
  const deployment = renderedResources.find((resource): resource is DeploymentResource => (
    isRecord(resource)
    && resource.kind === 'Deployment'
    && isRecord(resource.metadata)
    && resource.metadata.name === 'psfn-agent-11111111-1111-4111-8111-111111111111'
  ));
  const container = deployment?.spec?.template?.spec?.containers
    ?.find(candidate => candidate.name === 'agent');
  if (!container) throw new Error('Missing rendered fleet agent container');
  return container;
}

function componentContainer(component: 'agent' | 'garden' | 'gateway'): DeploymentContainer {
  const deploymentName = component === 'agent'
    ? 'psfn-agent-11111111-1111-4111-8111-111111111111'
    : `psfn-${component}`;
  const deployment = renderedResources.find((resource): resource is DeploymentResource => (
    isRecord(resource)
    && resource.kind === 'Deployment'
    && isRecord(resource.metadata)
    && resource.metadata.name === deploymentName
  ));
  const container = deployment?.spec?.template?.spec?.containers
    ?.find(candidate => candidate.name === component);
  if (!container) throw new Error(`Missing rendered ${component} container`);
  return container;
}

function envByName(component: 'agent' | 'garden' | 'gateway'): Map<string, SecretKeyRefEnv> {
  const entries = containerEnv(component);
  const result = new Map(entries.map(entry => [entry.name, entry]));
  expect(result.size).toBe(entries.length);
  return result;
}

describe('Helm runtime secret wiring', () => {
  it('mounts system-data writable only in the gateway', () => {
    const systemDataMount = (component: 'agent' | 'garden' | 'gateway') =>
      componentContainer(component).volumeMounts
        ?.find(mount => mount.name === 'system-data');

    expect(systemDataMount('gateway')).toMatchObject({
      mountPath: '/runtime/system-data',
    });
    expect(systemDataMount('gateway')?.readOnly).not.toBe(true);
    expect(systemDataMount('agent')).toMatchObject({
      mountPath: '/runtime/system-data',
      readOnly: true,
    });
    expect(systemDataMount('garden')).toMatchObject({
      mountPath: '/runtime/system-data',
      readOnly: true,
    });
  });

  it('keeps every templated agent and Garden system-data mount read-only', () => {
    const mountReadOnlyFlags = (template: string): boolean[] => {
      const lines = template.split('\n');
      return lines.flatMap((line, index) => (
        line.trim() === '- name: system-data'
        && lines[index + 1]?.trim().startsWith('mountPath:')
          ? [lines[index + 2]?.trim() === 'readOnly: true']
          : []
      ));
    };
    const workloadsTemplate = readFileSync(
      join(process.cwd(), 'deploy', 'helm', 'psfn', 'templates', 'workloads.yaml'),
      'utf8',
    );
    const fleetAgentsTemplate = readFileSync(
      join(process.cwd(), 'deploy', 'helm', 'psfn', 'templates', 'fleet-agents.yaml'),
      'utf8',
    );

    // workloads.yaml contains gateway, single-companion agent, and both Garden
    // branches in that order. Only the gateway mount may remain writable.
    expect(mountReadOnlyFlags(workloadsTemplate)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(mountReadOnlyFlags(fleetAgentsTemplate)).toEqual([true]);
  });

  it('keeps the gateway root proof-signing key inside the gateway container', () => {
    expect(envByName('gateway').get('GATEWAY_SESSION_HMAC_KEY')).toEqual({
      name: 'GATEWAY_SESSION_HMAC_KEY',
      valueFrom: {
        secretKeyRef: {
          key: 'GATEWAY_SESSION_HMAC_KEY',
          name: 'psfn-app',
        },
      },
    });
    expect(envByName('agent').has('GATEWAY_SESSION_HMAC_KEY')).toBe(false);
    expect(envByName('garden').has('GATEWAY_SESSION_HMAC_KEY')).toBe(false);
  });

  it('gives only the role-bound worker proof to the agent audit-key derivation boundary', () => {
    expect(envByName('agent').get('GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN')).toEqual({
      name: 'GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN',
      valueFrom: {
        secretKeyRef: {
          key: 'GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN',
          name: 'psfn-app',
        },
      },
    });
    expect(envByName('garden').has('GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN')).toBe(false);
  });

  it('renders semantic mTLS agent readiness instead of a TCP listener check', () => {
    const readiness = agentContainer().readinessProbe;
    expect(readiness?.tcpSocket).toBeUndefined();
    const command = readiness?.exec?.command?.join('\n') ?? '';
    expect(command).toContain('/api/admin/__transport_probe__');
    expect(command).toContain('ownSpiffeUri');
    expect(command).toContain('peer.subjectaltname');
    expect(command).not.toContain('fingerprint');
    expect(command).toContain('response.statusCode === 200');
    const certificate = renderedResources.find((resource): resource is CertificateResource => (
      isRecord(resource)
      && resource.kind === 'Certificate'
      && isRecord(resource.metadata)
      && resource.metadata.name === 'psfn-agent-admin-11111111-1111-4111-8111-111111111111'
    ));
    expect(certificate?.spec?.usages).toEqual([
      'digital signature',
      'key encipherment',
      'server auth',
      'client auth',
    ]);

    const singleAgentTemplate = readFileSync(
      join(process.cwd(), 'deploy', 'helm', 'psfn', 'templates', 'workloads.yaml'),
      'utf8',
    );
    expect(singleAgentTemplate).toContain("path: '/api/admin/__transport_probe__'");
    expect(singleAgentTemplate).toContain('ownSpiffeUri');
    expect(singleAgentTemplate).toContain('peer.subjectaltname');

    const agentMain = readFileSync(
      join(process.cwd(), 'src', 'app', 'agent', 'main.ts'),
      'utf8',
    );
    expect(agentMain.indexOf("await eventBus.emit('system.ready', {});"))
      .toBeLessThan(agentMain.indexOf('adminTransport?.markRuntimeReady();'));
  });

  it('keeps the agent admin Service routable while semantic runtime readiness is false', () => {
    const agentAdminServices = renderedResources.filter(resource => (
      isRecord(resource)
      && resource.kind === 'Service'
      && isRecord(resource.metadata)
      && typeof resource.metadata.name === 'string'
      && resource.metadata.name.startsWith('psfn-agent-admin')
    ));

    expect(agentAdminServices.length).toBeGreaterThan(0);
    for (const service of agentAdminServices) {
      expect(service.spec).toMatchObject({ publishNotReadyAddresses: true });
    }

    const gardenService = renderedResources.find(resource => (
      isRecord(resource)
      && resource.kind === 'Service'
      && isRecord(resource.metadata)
      && resource.metadata.name === 'psfn-garden'
    ));
    expect(gardenService?.spec).toMatchObject({ publishNotReadyAddresses: true });
  });
});
