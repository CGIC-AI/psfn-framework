// ── Live Helm release revision resolution (psfn-framework-6187t) ──
//
// The Helm revision a companion is running under is NOT a property of the pod.
// It used to be injected as `PSFN_HELM_REVISION` from `.Release.Revision`, which
// made every helm operation rewrite the pod template and force-restart the
// companion — and made the value stale in any pod that then outlived a later
// upgrade. Both problems have the same root cause: a per-operation fact frozen
// into a long-lived process.
//
// The revision is therefore resolved LAZILY, at the moment it is used, from
// Helm's own release history through an injected resolver. That keeps the fact
// where it actually lives (the release store) and keeps the credentials that can
// read it on the operator-job side, where the Helm transport already is.
//
// Fail-closed: a resolver that cannot answer raises a typed
// KubeHelmRevisionUnavailableError. Callers that steer a mutation — rollback
// targeting above all — must let it propagate rather than substitute a default;
// a wrong revision there rolls the release to the wrong content.

/**
 * Resolve the current (highest) Helm revision of a release. Implementations read
 * Helm's release store directly; see `createLiveHelmRollbackApi`.
 */
export type KubeHelmRevisionResolver = (
  namespace: string,
  release: string,
) => Promise<number>;

/** Raised when the live Helm revision cannot be established. */
export class KubeHelmRevisionUnavailableError extends Error {
  constructor(
    readonly namespace: string,
    readonly release: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Current Helm revision for release ${release} in namespace ${namespace} is unavailable: ${detail}`,
      options,
    );
    this.name = 'KubeHelmRevisionUnavailableError';
  }
}

/**
 * Resolve and validate the current Helm revision, normalising every failure mode
 * — a throwing transport, a non-integer, a zero/negative revision — into one
 * typed error. The underlying failure is preserved as `cause`.
 */
export async function resolveCurrentHelmRevision(
  resolver: KubeHelmRevisionResolver,
  namespace: string,
  release: string,
): Promise<number> {
  let revision: number;
  try {
    revision = await resolver(namespace, release);
  } catch (error) {
    throw new KubeHelmRevisionUnavailableError(
      namespace,
      release,
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new KubeHelmRevisionUnavailableError(
      namespace,
      release,
      `resolver returned ${String(revision)}, which is not a positive revision`,
    );
  }
  return revision;
}
