import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { describe, expect, it } from 'vitest';

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

interface DeploymentResource {
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    template?: {
      spec?: {
        containers?: Array<{
          env?: SecretKeyRefEnv[];
          name?: string;
        }>;
      };
    };
  };
}

const renderedResources = parseAllDocuments(execFileSync(
  'helm',
  ['template', 'psfn', join(process.cwd(), 'deploy', 'helm', 'psfn'), '--namespace', 'psfn-test'],
  { encoding: 'utf8' },
)).map(document => document.toJS() as DeploymentResource);

function containerEnv(component: 'agent' | 'garden' | 'gateway'): SecretKeyRefEnv[] {
  const deploymentName = `psfn-${component}`;
  const deployment = renderedResources.find(resource => (
    resource.kind === 'Deployment' && resource.metadata?.name === deploymentName
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

function envByName(component: 'agent' | 'garden' | 'gateway'): Map<string, SecretKeyRefEnv> {
  const entries = containerEnv(component);
  const result = new Map(entries.map(entry => [entry.name, entry]));
  expect(result.size).toBe(entries.length);
  return result;
}

describe('Helm runtime secret wiring', () => {
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
});
