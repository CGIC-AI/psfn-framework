// ── In-cluster Kubernetes rollout (write) API ──
// The mutating counterpart to kubernetes-read-api.ts. It issues a
// strategic-merge PATCH against a managed Deployment's pod template to trigger a
// rollout restart. The .4 Role grants `patch` on exactly the three managed
// Deployments and binds it to the gateway ServiceAccount, so this write path is
// available only from the gateway process behind the approval gate.

import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { KubeReadApiPort } from '../../system/lifecycle/kube-diagnostics.js';
import type { KubeRolloutApiPort } from '../../system/lifecycle/kube-rollout-restart.js';
import { createInClusterKubernetesReadApi, type InClusterKubernetesReadApiDeps } from './kubernetes-read-api.js';

const SERVICE_ACCOUNT_ROOT = '/var/run/secrets/kubernetes.io/serviceaccount';
const SERVICE_ACCOUNT_TOKEN_PATH = `${SERVICE_ACCOUNT_ROOT}/token`;
const SERVICE_ACCOUNT_CA_PATH = `${SERVICE_ACCOUNT_ROOT}/ca.crt`;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const STRATEGIC_MERGE_PATCH_CONTENT_TYPE = 'application/strategic-merge-patch+json';
const RESTART_ANNOTATION = 'kubectl.kubernetes.io/restartedAt';
// eslint-disable-next-line no-control-regex
const CONTROL_OR_WHITESPACE = new RegExp('\\s|[\\u0000-\\u001f\\u007f]', 'u');

export interface KubernetesPatchTransport {
  patchJson(path: string, body: string, contentType: string): Promise<void>;
}

export interface CreateKubernetesRolloutApiDeps {
  read: KubeReadApiPort;
  patch: KubernetesPatchTransport;
  now?: () => Date;
}

function requireDnsLabel(field: string, value: string): void {
  if (!DNS_LABEL_PATTERN.test(value)) {
    throw new Error(`Kubernetes ${field} must be a DNS label.`);
  }
}

export function createKubernetesRolloutApi(
  deps: CreateKubernetesRolloutApiDeps,
): KubeRolloutApiPort {
  const now = deps.now ?? (() => new Date());
  return {
    getDeployment: (namespace, name) => deps.read.getDeployment(namespace, name),
    restartDeployment: async (namespace, name) => {
      requireDnsLabel('namespace', namespace);
      requireDnsLabel('Deployment name', name);
      const body = JSON.stringify({
        spec: {
          template: {
            metadata: {
              annotations: {
                [RESTART_ANNOTATION]: now().toISOString(),
              },
            },
          },
        },
      });
      const path = `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`;
      await deps.patch.patchJson(path, body, STRATEGIC_MERGE_PATCH_CONTENT_TYPE);
    },
  };
}

export interface InClusterKubernetesPatchRequestOptions {
  hostname: string;
  port: number;
  path: string;
  ca: Buffer;
  token: string;
  body: string;
  contentType: string;
}

export interface InClusterKubernetesRolloutApiDeps extends InClusterKubernetesReadApiDeps {
  rolloutRequestTimeoutMs: number;
  readToken?: (path: string) => string;
  readCa?: (path: string) => Buffer;
  patchRequest?: (options: InClusterKubernetesPatchRequestOptions) => Promise<void>;
  now?: () => Date;
}

function requireServiceHost(env: NodeJS.ProcessEnv): string {
  const host = env.KUBERNETES_SERVICE_HOST?.trim() ?? '';
  if (!host || host.length > 253 || /[\s/\\]/.test(host)) {
    throw new Error('KUBERNETES_SERVICE_HOST is required for in-cluster Kubernetes rollout.');
  }
  return host;
}

function requireServicePort(env: NodeJS.ProcessEnv): number {
  const raw = env.KUBERNETES_SERVICE_PORT_HTTPS?.trim()
    || env.KUBERNETES_SERVICE_PORT?.trim()
    || '';
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('KUBERNETES_SERVICE_PORT_HTTPS is required for in-cluster Kubernetes rollout.');
  }
  return port;
}

function loadServiceAccountToken(readToken: (path: string) => string): string {
  const token = readToken(SERVICE_ACCOUNT_TOKEN_PATH).trim();
  if (!token || token.length > 16_384 || CONTROL_OR_WHITESPACE.test(token)) {
    throw new Error('Kubernetes ServiceAccount token is missing or invalid.');
  }
  return token;
}

function patchKubernetesJson(
  options: InClusterKubernetesPatchRequestOptions,
  requestTimeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: options.hostname,
      port: options.port,
      path: options.path,
      method: 'PATCH',
      ca: options.ca,
      rejectUnauthorized: true,
      headers: {
        Accept: 'application/json',
        'Content-Type': options.contentType,
        'Content-Length': Buffer.byteLength(options.body),
        Authorization: `Bearer ${options.token}`,
      },
    }, (response) => {
      // Drain the body so the socket can be reused/closed cleanly.
      response.on('data', () => undefined);
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Kubernetes rollout restart failed with HTTP ${response.statusCode ?? 'unknown'}.`));
          return;
        }
        resolve();
      });
    });
    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(new Error('Kubernetes rollout restart request timed out.'));
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

export function createInClusterKubernetesRolloutApi(
  env: NodeJS.ProcessEnv,
  deps: InClusterKubernetesRolloutApiDeps,
): KubeRolloutApiPort {
  if (!Number.isSafeInteger(deps.rolloutRequestTimeoutMs)
    || deps.rolloutRequestTimeoutMs <= 0) {
    throw new Error('Kubernetes rollout request timeout must be a positive integer.');
  }
  const hostname = requireServiceHost(env);
  const port = requireServicePort(env);
  const readToken = deps.readToken ?? (path => readFileSync(path, 'utf8'));
  const ca = (deps.readCa ?? (path => readFileSync(path)))(SERVICE_ACCOUNT_CA_PATH);
  const patchRequest = deps.patchRequest
    ?? (options => patchKubernetesJson(options, deps.rolloutRequestTimeoutMs));
  const read = createInClusterKubernetesReadApi(env, deps);

  return createKubernetesRolloutApi({
    read,
    now: deps.now,
    patch: {
      patchJson: async (path, body, contentType) => {
        const token = loadServiceAccountToken(readToken);
        await patchRequest({ hostname, port, path, ca, token, body, contentType });
      },
    },
  });
}
