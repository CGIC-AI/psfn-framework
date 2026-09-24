/**
 * Agent egress-isolation proof (psfn-framework-hrcx5).
 *
 * A failed request to one public address is not proof of isolation: selective
 * egress, a target outage, DNS failure, or a timeout look identical from inside
 * the container. The proof therefore has three outcomes:
 *
 * - `reachable`: any independent target answered (any HTTP status, or a TLS
 *   peer that completed a handshake — including an intercepting proxy).
 * - `isolated`: every target failed at the network layer AND the launcher
 *   declared the platform isolation that explains those failures
 *   (`PSFN_AGENT_EGRESS_ISOLATION`). Probe failures alone never prove it.
 * - `unknown`: anything else (no declaration, DNS/unclassified errors). The
 *   caller fails closed on `unknown`.
 */

/** Launcher-declared platform isolation mechanisms the agent accepts as evidence. */
export const AGENT_EGRESS_ISOLATION_ENV = 'PSFN_AGENT_EGRESS_ISOLATION';
const DECLARED_ISOLATION_MECHANISMS: ReadonlySet<string> = new Set([
  // Kubernetes NetworkPolicy restricting the agent pod's egress (chart-owned).
  'kubernetes-network-policy',
  // Container attached only to an internal (no default route) network.
  'container-internal-network',
]);

/**
 * Independent operators and protocols, addressed by IP literal so DNS is not
 * part of the proof. Any answer from any of them is reachability.
 */
const DEFAULT_EGRESS_PROBE_TARGETS: readonly string[] = Object.freeze([
  'http://1.1.1.1/cdn-cgi/trace',
  'https://1.0.0.1/cdn-cgi/trace',
  'http://8.8.8.8/',
  'https://9.9.9.9/',
]);

export type EgressProbeOutcome =
  | { target: string; kind: 'answered'; detail: string }
  | { target: string; kind: 'blocked'; detail: string }
  | { target: string; kind: 'unclassified'; detail: string };

export type EgressIsolationVerdict =
  | { status: 'reachable'; probes: EgressProbeOutcome[] }
  | { status: 'isolated'; mechanism: string; probes: EgressProbeOutcome[] }
  | { status: 'unknown'; reason: string; probes: EgressProbeOutcome[] };

/** Connection failures a network policy, missing route, or reject rule produces. */
const NETWORK_BLOCK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'EACCES',
  'EPERM',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Timeout-shaped abort names from AbortSignal.timeout / undici. */
const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set(['TimeoutError', 'AbortError']);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && !chain.includes(current)) {
    chain.push(current);
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

/** Classify one failed probe from its error chain. */
export function classifyProbeError(target: string, error: unknown): EgressProbeOutcome {
  const chain = errorChain(error);
  const codes = chain.map(errorCode).filter((code): code is string => code !== undefined);
  const names = chain.map(errorName).filter((name): name is string => name !== undefined);
  const detail = [...codes, ...names].join(',') || 'unknown-error';
  // A TLS failure means a peer completed TCP and spoke TLS: the address (or an
  // interceptor in front of it) is reachable.
  if (codes.some(code => code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')
    || code.includes('CERT') || code.includes('SELF_SIGNED') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')) {
    return { target, kind: 'answered', detail };
  }
  if (codes.some(code => NETWORK_BLOCK_CODES.has(code))
    || names.some(name => TIMEOUT_ERROR_NAMES.has(name))) {
    return { target, kind: 'blocked', detail };
  }
  return { target, kind: 'unclassified', detail };
}

export interface EgressProbeOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  targets?: readonly string[];
  fetchImpl?: typeof fetch;
}

async function probeTarget(
  target: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<EgressProbeOutcome> {
  try {
    const response = await fetchImpl(target, {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { target, kind: 'answered', detail: `status=${response.status}` };
  } catch (error) {
    return classifyProbeError(target, error);
  }
}

/** Parse the launcher declaration; an unrecognized value rejects. */
function parseDeclaredIsolation(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[AGENT_EGRESS_ISOLATION_ENV]?.trim();
  if (!raw) return undefined;
  if (!DECLARED_ISOLATION_MECHANISMS.has(raw)) {
    throw new Error(
      `${AGENT_EGRESS_ISOLATION_ENV}=${raw} is not a recognized isolation mechanism `
      + `(expected one of: ${[...DECLARED_ISOLATION_MECHANISMS].join(', ')}).`,
    );
  }
  return raw;
}

export async function proveAgentEgressIsolation(
  options: EgressProbeOptions,
): Promise<EgressIsolationVerdict> {
  const mechanism = parseDeclaredIsolation(options.env);
  const targets = options.targets ?? DEFAULT_EGRESS_PROBE_TARGETS;
  if (targets.length < 2) {
    throw new Error('Egress isolation proof requires at least two independent probe targets.');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const probes = await Promise.all(
    targets.map(target => probeTarget(target, options.timeoutMs, fetchImpl)),
  );
  if (probes.some(probe => probe.kind === 'answered')) {
    return { status: 'reachable', probes };
  }
  if (probes.some(probe => probe.kind === 'unclassified')) {
    return {
      status: 'unknown',
      reason: 'one or more probes failed for a reason that does not prove a network block',
      probes,
    };
  }
  if (!mechanism) {
    return {
      status: 'unknown',
      reason: `every probe failed but the launcher declared no ${AGENT_EGRESS_ISOLATION_ENV} mechanism; `
        + 'failed probes alone cannot distinguish isolation from selective egress or an outage',
      probes,
    };
  }
  return { status: 'isolated', mechanism, probes };
}
