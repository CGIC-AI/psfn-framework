// ── Live post-rollout validation transport (x5rt.7 seam) ──
//
// The credential-bearing PostRolloutValidationRunner the operator job supplies to
// the deploy pipeline. It probes the live-rolled companion via kubectl + HTTP and
// reuses the x5rt.3 conformance / x5rt.2 diagnostics contracts fetched from the
// NEW pod. Every probe is fail-closed: a thrown/unreadable probe becomes an
// inconclusive check (the gate treats that as a failure) — a companion that
// cannot PROVE health is not healthy. Composed ONLY in the operator entrypoint.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { isRecord } from '../../shared/utils/types.js';
import type {
  PostRolloutValidationContext,
  PostRolloutValidationRunner,
  RawCheckResult,
  ToolConformanceSkipped,
} from '../../system/lifecycle/kube-post-rollout-validation.js';
import { managedRollbackDeploymentNames } from '../../system/lifecycle/kube-helm-rollback.js';
import { isDeploymentRolloutComplete } from '../../system/lifecycle/kube-rollout-restart.js';
import type { ToolConformanceRunResult } from '../../core/agent/tool-conformance/types.js';
import type { RuntimeDiagnosticsSnapshot } from '../../shared/diagnostics/runtime-diagnostics.js';
import {
  type CommandRunner,
} from './kube-self-update-transport.js';

export interface HttpJsonResponse {
  status: number;
  body: string;
}

export type HttpJsonFetcher = (
  method: 'GET' | 'POST',
  url: string,
  options?: { headers?: Record<string, string>; body?: string },
) => Promise<HttpJsonResponse>;

/** Build the HTTP transport with its timeout owned by settings.json. */
export function createNodeHttpJsonFetcher(requestTimeoutMs: number): HttpJsonFetcher {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('Kube self-update HTTP timeout must be a positive integer.');
  }
  return (method, url, options = {}) => new Promise<HttpJsonResponse>((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport(
      parsed,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(options.body !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(options.body) }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.setTimeout(requestTimeoutMs, () => req.destroy(new Error(`HTTP ${method} ${url} timed out`)));
    req.once('error', reject);
    if (options.body !== undefined) req.end(options.body);
    else req.end();
  });
}

export interface LivePostRolloutValidationConfig {
  namespace: string;
  resourcePrefix: string;
  kubectlBin?: string;
  kubectlGlobalArgs?: readonly string[];
  run: CommandRunner;
  http: HttpJsonFetcher;
  /** Garden /health URL. */
  gardenHealthUrl: string;
  /** Gateway /v1/models URL and the model id that MUST be present. */
  modelRouteUrl: string;
  expectedModelId: string;
  /** Two-turn chat smoke against the gateway; injected because it needs a companion prompt. */
  chatTurnProbe: (context: PostRolloutValidationContext) => Promise<RawCheckResult>;
  /** pgvector presence probe (e.g. kubectl exec psql). */
  pgVectorProbe: (context: PostRolloutValidationContext) => Promise<RawCheckResult>;
  /** Redis PING probe (e.g. kubectl exec redis-cli). */
  redisProbe: (context: PostRolloutValidationContext) => Promise<RawCheckResult>;
  /** Fetch the x5rt.3 conformance result from the NEW pod, or an explicit skip. */
  fetchToolConformance: (
    context: PostRolloutValidationContext,
  ) => Promise<ToolConformanceRunResult | ToolConformanceSkipped>;
  /** Fetch the x5rt.2 diagnostics snapshot from the NEW pod. */
  fetchDiagnostics: (context: PostRolloutValidationContext) => Promise<RuntimeDiagnosticsSnapshot>;
}

function pass(detail?: string, evidence?: Record<string, unknown>): RawCheckResult {
  return { verdict: 'pass', ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) };
}
function fail(detail: string, evidence?: Record<string, unknown>): RawCheckResult {
  return { verdict: 'fail', detail, ...(evidence ? { evidence } : {}) };
}

export interface KubectlExecProbeConfig {
  kubectlBin?: string;
  kubectlGlobalArgs?: readonly string[];
  run: CommandRunner;
  namespace: string;
  /** Label selector for the target pod (first matching pod is used). */
  podSelector: string;
  /** Container name to exec into (optional). */
  container?: string;
  /** Command + args run inside the pod. */
  command: readonly string[];
  /** Case-insensitive substring the stdout MUST contain to pass. */
  expectSubstring: string;
}

/**
 * A live probe that execs a command inside the first pod matching a selector and
 * passes iff the stdout contains the expected substring. Fail-closed: a non-zero
 * exit, a missing pod, or a missing substring all fail; a thrown exec propagates
 * and the gate records it as inconclusive.
 */
export function createKubectlExecProbe(
  config: KubectlExecProbeConfig,
): () => Promise<RawCheckResult> {
  const kubectl = config.kubectlBin ?? 'kubectl';
  const run = config.run;
  return async () => {
    const podResult = await run(kubectl, [
      ...(config.kubectlGlobalArgs ?? []),
      'get', 'pods', '-n', config.namespace, '-l', config.podSelector,
      '-o', 'jsonpath={.items[0].metadata.name}',
    ]);
    const podName = podResult.stdout.trim();
    if (podResult.code !== 0 || podName.length === 0) {
      return fail(`no pod for selector ${config.podSelector}`);
    }
    const execResult = await run(kubectl, [
      ...(config.kubectlGlobalArgs ?? []),
      'exec', podName, '-n', config.namespace,
      ...(config.container ? ['-c', config.container] : []),
      '--', ...config.command,
    ]);
    if (execResult.code !== 0) {
      return fail(`exec failed in ${podName}: ${(execResult.stderr || execResult.stdout).trim().slice(-200)}`);
    }
    const matched = execResult.stdout.toLowerCase().includes(config.expectSubstring.toLowerCase());
    return matched
      ? pass(undefined, { pod: podName })
      : fail(`expected "${config.expectSubstring}" not found in exec output`, { pod: podName });
  };
}

export interface HttpChatTurnProbeConfig {
  http: HttpJsonFetcher;
  chatCompletionsUrl: string;
  model: string;
  headers?: Record<string, string>;
}

/**
 * A minimal two-turn chat smoke against the gateway /v1/chat/completions: both
 * turns must return HTTP 200 with a non-empty assistant message. Fail-closed on
 * any non-200 or empty completion.
 */
export function createHttpChatTurnProbe(
  config: HttpChatTurnProbeConfig,
): () => Promise<RawCheckResult> {
  const http = config.http;
  const turn = async (content: string): Promise<boolean> => {
    const res = await http('POST', config.chatCompletionsUrl, {
      ...(config.headers ? { headers: config.headers } : {}),
      body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content }] }),
    });
    if (res.status !== 200) return false;
    try {
      const body: unknown = JSON.parse(res.body);
      const choices = isRecord(body) && Array.isArray(body.choices) ? body.choices : [];
      const first = choices[0];
      const message = isRecord(first) && isRecord(first.message) ? first.message : undefined;
      return typeof message?.content === 'string' && message.content.trim().length > 0;
    } catch {
      return false;
    }
  };
  return async () => {
    const first = await turn('post-rollout smoke: reply with a short greeting');
    if (!first) return fail('first chat turn did not return a completion');
    const second = await turn('post-rollout smoke: reply with a short acknowledgement');
    if (!second) return fail('second chat turn did not return a completion');
    return pass();
  };
}

/**
 * Assemble the live post-rollout validation runner. The generic cluster/HTTP
 * probes (rollout status, agent readiness, garden health, model route) are
 * implemented here; the app-internal probes (chat turn, pgvector, redis,
 * conformance, diagnostics) are injected so the operator wires the exact in-pod
 * commands/endpoints for the deployment under management.
 */
export function createLivePostRolloutValidationRunner(
  config: LivePostRolloutValidationConfig,
): PostRolloutValidationRunner {
  const kubectl = config.kubectlBin ?? 'kubectl';
  const run = config.run;
  const http = config.http;
  const deploymentNames = managedRollbackDeploymentNames(config.resourcePrefix);

  const getDeploymentJson = async (name: string): Promise<unknown> => {
    const result = await run(kubectl, [
      ...(config.kubectlGlobalArgs ?? []),
      'get', 'deployment', name, '-n', config.namespace, '-o', 'json',
    ]);
    if (result.code !== 0) {
      throw new Error(`kubectl get deployment ${name} failed: ${(result.stderr || result.stdout).trim().slice(-400)}`);
    }
    return JSON.parse(result.stdout);
  };

  const readDeployment = (name: string, json: unknown) => {
    const j = isRecord(json) ? json : {};
    const metadata = isRecord(j.metadata) ? j.metadata : {};
    const spec = isRecord(j.spec) ? j.spec : {};
    const status = isRecord(j.status) ? j.status : {};
    const asInt = (v: unknown): number =>
      typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
    return {
      name,
      generation: asInt(metadata.generation),
      observedGeneration: asInt(status.observedGeneration),
      desiredReplicas: asInt(spec.replicas),
      readyReplicas: asInt(status.readyReplicas),
      updatedReplicas: asInt(status.updatedReplicas),
      availableReplicas: asInt(status.availableReplicas),
    };
  };

  return {
    checkRolloutStatus: async () => {
      const deployments = await Promise.all(
        deploymentNames.map(async name => readDeployment(name, await getDeploymentJson(name))),
      );
      const pending = deployments.filter(d => !isDeploymentRolloutComplete(d));
      if (pending.length > 0) {
        return fail(`deployments not rolled out: ${pending.map(d => d.name).join(', ')}`, {
          pending: pending.map(d => ({ name: d.name, ready: d.readyReplicas, desired: d.desiredReplicas })),
        });
      }
      return pass(undefined, { deployments: deployments.map(d => d.name) });
    },
    checkGardenHealth: async () => {
      const res = await http('GET', config.gardenHealthUrl);
      if (res.status !== 200) return fail(`garden health HTTP ${res.status}`);
      try {
        const body: unknown = JSON.parse(res.body);
        const ok = isRecord(body) && (body.status === 'ok' || body.ok === true);
        return ok ? pass() : fail('garden health did not report ok', { body: res.body.slice(0, 200) });
      } catch {
        return fail('garden health returned non-JSON body');
      }
    },
    checkModelRoute: async () => {
      const res = await http('GET', config.modelRouteUrl);
      if (res.status !== 200) return fail(`model route HTTP ${res.status}`);
      try {
        const body: unknown = JSON.parse(res.body);
        const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
        const ids = data.filter(isRecord).map(entry => entry.id).filter((id): id is string => typeof id === 'string');
        return ids.includes(config.expectedModelId)
          ? pass(undefined, { models: ids.slice(0, 20) })
          : fail(`expected model ${config.expectedModelId} not in /v1/models`, { models: ids.slice(0, 20) });
      } catch {
        return fail('model route returned non-JSON body');
      }
    },
    checkPgVector: (context) => config.pgVectorProbe(context),
    checkRedis: (context) => config.redisProbe(context),
    checkAgentReadiness: async (context) => {
      const agentName = `${config.resourcePrefix}-agent`;
      const podsResult = await run(kubectl, [
        ...(config.kubectlGlobalArgs ?? []),
        'get', 'pods', '-n', config.namespace,
        '-l', `app.kubernetes.io/component=agent`, '-o', 'json',
      ]);
      if (podsResult.code !== 0) {
        return fail(`kubectl get agent pods failed: ${(podsResult.stderr || podsResult.stdout).trim().slice(-300)}`);
      }
      let items: unknown[] = [];
      try {
        const parsed: unknown = JSON.parse(podsResult.stdout);
        items = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
      } catch {
        return fail('agent pod list returned non-JSON body');
      }
      if (items.length === 0) return fail(`no agent pods found for ${agentName}`);
      for (const item of items) {
        if (!isRecord(item)) return fail('malformed agent pod entry');
        const status = isRecord(item.status) ? item.status : {};
        const containerStatuses = Array.isArray(status.containerStatuses) ? status.containerStatuses : [];
        for (const cs of containerStatuses) {
          if (!isRecord(cs)) continue;
          const state = isRecord(cs.state) ? cs.state : {};
          if (isRecord(state.waiting) && state.waiting.reason === 'CrashLoopBackOff') {
            return fail('agent container is CrashLoopBackOff');
          }
          if (cs.ready !== true) {
            return fail('agent container is not ready');
          }
          const image = typeof cs.image === 'string' ? cs.image : '';
          if (!image.includes(context.imageTag)) {
            return fail(`running agent image ${image} does not match target tag ${context.imageTag}`, { image });
          }
        }
      }
      return pass();
    },
    checkChatTurnProbe: (context) => config.chatTurnProbe(context),
    fetchToolConformance: (context) => config.fetchToolConformance(context),
    fetchDiagnostics: (context) => config.fetchDiagnostics(context),
  };
}
