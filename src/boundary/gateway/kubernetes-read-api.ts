import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type {
  KubeDeploymentDiagnostic,
  KubePodDiagnostic,
  KubeReadApiPort,
} from '../../system/lifecycle/kube-diagnostics.js';
import { isRecord } from '../../shared/utils/types.js';

const SERVICE_ACCOUNT_ROOT = '/var/run/secrets/kubernetes.io/serviceaccount';
const SERVICE_ACCOUNT_TOKEN_PATH = `${SERVICE_ACCOUNT_ROOT}/token`;
const SERVICE_ACCOUNT_CA_PATH = `${SERVICE_ACCOUNT_ROOT}/ca.crt`;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface InClusterKubernetesRequestOptions {
  hostname: string;
  port: number;
  path: string;
  ca: Buffer;
  token: string;
}

export interface InClusterKubernetesReadApiDeps {
  readToken?: (path: string) => string;
  readCa?: (path: string) => Buffer;
  requestJson?: (options: InClusterKubernetesRequestOptions) => Promise<unknown>;
}

export interface KubernetesJsonTransport {
  getJson(path: string): Promise<unknown>;
}

function requireDnsLabel(field: string, value: string): void {
  if (!DNS_LABEL_PATTERN.test(value)) {
    throw new Error(`Kubernetes ${field} must be a DNS label.`);
  }
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Kubernetes API returned invalid ${label} data.`);
  }
  return value;
}

function requireName(metadata: unknown, expected?: string): string {
  const record = requireObject(metadata, 'metadata');
  const name = record.name;
  if (typeof name !== 'string' || !DNS_LABEL_PATTERN.test(name)) {
    throw new Error('Kubernetes API returned invalid resource metadata.');
  }
  if (expected !== undefined && name !== expected) {
    throw new Error('Kubernetes API returned a resource outside the requested scope.');
  }
  return name;
}

function deploymentDiagnostic(value: unknown, expectedName: string): KubeDeploymentDiagnostic {
  const record = requireObject(value, 'Deployment');
  const metadata = requireObject(record.metadata, 'Deployment metadata');
  const spec = requireObject(record.spec, 'Deployment spec');
  const status = requireObject(record.status, 'Deployment status');
  return {
    name: requireName(metadata, expectedName),
    generation: nonNegativeInteger(metadata.generation),
    observedGeneration: nonNegativeInteger(status.observedGeneration),
    desiredReplicas: nonNegativeInteger(spec.replicas),
    readyReplicas: nonNegativeInteger(status.readyReplicas),
    updatedReplicas: nonNegativeInteger(status.updatedReplicas),
    availableReplicas: nonNegativeInteger(status.availableReplicas),
  };
}

function podDiagnostic(value: unknown): KubePodDiagnostic {
  const record = requireObject(value, 'Pod');
  const status = requireObject(record.status, 'Pod status');
  if (typeof status.phase !== 'string' || status.phase.length === 0 || status.phase.length > 64) {
    throw new Error('Kubernetes API returned invalid Pod phase data.');
  }
  const rawStatuses = status.containerStatuses;
  if (!Array.isArray(rawStatuses)) {
    throw new Error('Kubernetes API returned invalid Pod container status data.');
  }
  const containerStatuses = rawStatuses.map(item => requireObject(item, 'Pod container status'));
  const images = [...new Set(containerStatuses.map((container) => {
    if (typeof container.image !== 'string' || container.image.length === 0 || container.image.length > 512) {
      throw new Error('Kubernetes API returned invalid Pod image data.');
    }
    return container.image;
  }))];
  return {
    name: requireName(record.metadata),
    phase: status.phase,
    ready: containerStatuses.length > 0 && containerStatuses.every(container => container.ready === true),
    restartCount: containerStatuses.reduce(
      (total, container) => total + nonNegativeInteger(container.restartCount),
      0,
    ),
    images,
  };
}

export function createKubernetesReadApi(
  transport: KubernetesJsonTransport,
): KubeReadApiPort {
  return {
    getDeployment: async (namespace, name) => {
      requireDnsLabel('namespace', namespace);
      requireDnsLabel('Deployment name', name);
      const path = `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`;
      return deploymentDiagnostic(await transport.getJson(path), name);
    },
    listPods: async (namespace, labelSelector) => {
      requireDnsLabel('namespace', namespace);
      if (!/^app\.kubernetes\.io\/instance=[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(labelSelector)) {
        throw new Error('Kubernetes Pod label selector is outside the release scope.');
      }
      const path = `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(labelSelector)}`;
      const response = requireObject(await transport.getJson(path), 'Pod list');
      if (!Array.isArray(response.items)) {
        throw new Error('Kubernetes API returned invalid Pod list data.');
      }
      return response.items.map(podDiagnostic);
    },
  };
}

function requireServiceHost(env: NodeJS.ProcessEnv): string {
  const host = env.KUBERNETES_SERVICE_HOST?.trim() ?? '';
  if (!host || host.length > 253 || /[\s/\\]/.test(host)) {
    throw new Error('KUBERNETES_SERVICE_HOST is required for in-cluster Kubernetes diagnostics.');
  }
  return host;
}

function requireServicePort(env: NodeJS.ProcessEnv): number {
  const raw = env.KUBERNETES_SERVICE_PORT_HTTPS?.trim()
    || env.KUBERNETES_SERVICE_PORT?.trim()
    || '';
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('KUBERNETES_SERVICE_PORT_HTTPS is required for in-cluster Kubernetes diagnostics.');
  }
  return port;
}

function loadServiceAccountToken(readToken: (path: string) => string): string {
  const token = readToken(SERVICE_ACCOUNT_TOKEN_PATH).trim();
  if (!token || token.length > 16_384 || /\s|[\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error('Kubernetes ServiceAccount token is missing or invalid.');
  }
  return token;
}

function requestKubernetesJson(
  options: InClusterKubernetesRequestOptions,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: options.hostname,
      port: options.port,
      path: options.path,
      method: 'GET',
      ca: options.ca,
      rejectUnauthorized: true,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${options.token}`,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('Kubernetes API response exceeded the size limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Kubernetes API read failed with HTTP ${response.statusCode ?? 'unknown'}.`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          reject(new Error('Kubernetes API returned invalid JSON.'));
        }
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('Kubernetes API read timed out.'));
    });
    request.once('error', reject);
    request.end();
  });
}

export function createInClusterKubernetesReadApi(
  env: NodeJS.ProcessEnv = process.env,
  deps: InClusterKubernetesReadApiDeps = {},
): KubeReadApiPort {
  const hostname = requireServiceHost(env);
  const port = requireServicePort(env);
  const readToken = deps.readToken ?? (path => readFileSync(path, 'utf8'));
  const ca = (deps.readCa ?? (path => readFileSync(path)))(SERVICE_ACCOUNT_CA_PATH);
  const requestJson = deps.requestJson ?? requestKubernetesJson;

  return createKubernetesReadApi({
    getJson: async (path): Promise<unknown> => {
      const token = loadServiceAccountToken(readToken);
      return await requestJson({
        hostname,
        port,
        path,
        ca,
        token,
      });
    },
  });
}
