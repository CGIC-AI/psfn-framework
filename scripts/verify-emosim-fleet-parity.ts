import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { isRecord } from '../src/shared/utils/types.js';
import { validateCompanionsConfig } from '../src/system/config/companions-config.js';

const BASE_COMMIT = '5689c737d756a3673bf8e9675648f21a8cd0dde5';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const CHART_DIR = join(REPO_ROOT, 'deploy', 'helm', 'psfn');
const VALUES_PATH = join(SCRIPT_DIR, 'emosim-fleet-parity-values.yaml');
const COMPANIONS_PATH = join(SCRIPT_DIR, 'emosim-fleet-parity-companions.json');

const COMPANIONS = Object.freeze([
  { companionId: '11111111-1111-4111-8111-111111111111', displayName: 'Purrsephone' },
  { companionId: '22222222-2222-4222-8222-222222222222', displayName: 'Artemis' },
  { companionId: '33333333-3333-4333-8333-333333333333', displayName: 'V Unit 00' },
]);

interface KubernetesResource {
  kind: string;
  metadata: Record<string, unknown>;
  spec: Record<string, unknown>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function parseResources(rendered: string): KubernetesResource[] {
  return parseAllDocuments(rendered).flatMap((document): KubernetesResource[] => {
    if (document.errors.length > 0) {
      throw new Error(`Rendered fleet chart is invalid YAML: ${document.errors[0]?.message}`);
    }
    const value: unknown = document.toJS();
    if (!isRecord(value) || typeof value.kind !== 'string') return [];
    return [{
      kind: value.kind,
      metadata: requireRecord(value.metadata, `${value.kind}.metadata`),
      spec: isRecord(value.spec) ? value.spec : {},
    }];
  });
}

function labelsOf(resource: KubernetesResource): Record<string, unknown> {
  return requireRecord(resource.metadata.labels, `${resource.kind}.metadata.labels`);
}

function companionIdOf(resource: KubernetesResource): string | null {
  const value = labelsOf(resource)['psfn.io/companion-id'];
  return typeof value === 'string' ? value : null;
}

function assertLegacyFirstDivergence(): void {
  const legacyEmosimTemplate = execFileSync(
    'git',
    ['show', `${BASE_COMMIT}:deploy/helm/psfn/templates/emosim.yaml`],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const legacyFleetAgentTemplate = execFileSync(
    'git',
    ['show', `${BASE_COMMIT}:deploy/helm/psfn/templates/fleet-agents.yaml`],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const legacyEmosimDeployments = legacyEmosimTemplate.match(/kind: Deployment/gu)?.length ?? 0;
  if (legacyEmosimDeployments !== 1
    || legacyEmosimTemplate.includes('range $companion := .Values.fleet.companions')
    || !legacyFleetAgentTemplate.includes('range $companion := .Values.fleet.companions')) {
    throw new Error('The sanitized base capture no longer proves the service-supervision mismatch');
  }
}

function assertCurrentFleet(resources: readonly KubernetesResource[]): void {
  const manifest = validateCompanionsConfig(
    JSON.parse(readFileSync(COMPANIONS_PATH, 'utf8')) as unknown,
    COMPANIONS_PATH,
  );
  const emosimResources = resources.filter(resource => (
    labelsOf(resource)['app.kubernetes.io/component'] === 'emosim'
  ));
  for (const companion of COMPANIONS) {
    const binding = manifest.companions.find(entry => entry.companionId === companion.companionId)
      ?.observerEvalSidecar;
    if (!binding) {
      throw new Error(`${companion.displayName} (${companion.companionId}) has no EmoSim manifest binding`);
    }
    const owned = emosimResources.filter(resource => companionIdOf(resource) === companion.companionId);
    for (const kind of ['Service', 'PersistentVolumeClaim', 'Deployment', 'NetworkPolicy']) {
      const matches = owned.filter(resource => resource.kind === kind);
      if (matches.length !== 1) {
        throw new Error(
          `${companion.displayName} (${companion.companionId}) requires exactly one ${kind}; got ${matches.length}`,
        );
      }
    }
    const deployment = owned.find(resource => resource.kind === 'Deployment')!;
    const podLabels = requireRecord(
      requireRecord(
        requireRecord(deployment.spec.template, 'Deployment.spec.template').metadata,
        'Deployment.spec.template.metadata',
      ).labels,
      'Deployment.spec.template.metadata.labels',
    );
    if (podLabels['psfn.io/companion-id'] !== companion.companionId) {
      throw new Error(`${companion.displayName} EmoSim pod lost its immutable companion identity`);
    }
    const serviceName = String(owned.find(resource => resource.kind === 'Service')!.metadata.name);
    const endpoint = new URL(binding.serverUrl);
    if (endpoint.hostname !== serviceName
      || endpoint.port !== '17342'
      || !binding.sessionLabel.includes(companion.displayName === 'V Unit 00' ? 'v-unit-00' : companion.displayName.toLowerCase())
      || !binding.agentName.includes(companion.displayName === 'V Unit 00' ? 'v-unit-00' : companion.displayName.toLowerCase())
      || !binding.persistenceRootDir.endsWith(companion.companionId)) {
      throw new Error(`${companion.displayName} manifest binding does not resolve to its rendered EmoSim workload`);
    }
  }
  for (const kind of ['Service', 'PersistentVolumeClaim', 'Deployment', 'NetworkPolicy']) {
    const named = emosimResources.filter(resource => resource.kind === kind);
    const names = named.map(resource => String(resource.metadata.name));
    if (named.length !== COMPANIONS.length || new Set(names).size !== COMPANIONS.length) {
      throw new Error(`EmoSim ${kind} resources are incomplete or duplicated`);
    }
  }
}

function main(): void {
  assertLegacyFirstDivergence();
  const rendered = execFileSync(
    'helm',
    ['template', 'emosim-parity', CHART_DIR, '--values', VALUES_PATH],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const resources = parseResources(rendered);
  assertCurrentFleet(resources);
  const report = {
    status: 'pass',
    baseCommit: BASE_COMMIT,
    firstDivergentTransition: 'service_supervision',
    cause: 'base chart rendered one shared EmoSim workload for three companion agent workloads',
    companions: COMPANIONS.map(companion => ({
      ...companion,
      manifest: 'resolved',
      agentStartup: 'configured',
      emosimService: 'unique',
      storage: 'unique',
      gardenIdentity: 'companion-bound',
    })),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
