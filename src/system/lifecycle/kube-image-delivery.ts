import { isRecord } from '../../shared/utils/types.js';
import { isPinnedKubeImageReference } from './kube-self-management.js';

/**
 * How a built self-update image reaches the node that runs it (deploy pipeline
 * stage 5, `import`).
 *
 * - `registry-push`: the pinned reference names a loopback registry
 *   (`localhost:<port>/...` or `127.0.0.1:<port>/...`). The image is pushed
 *   there and the node pulls it. Kubelet image GC can then never strand a
 *   rollout, because a collected image is simply pulled again. This is the
 *   production delivery path.
 * - `ctr-import`: the pinned reference is a registry-less `localhost/...` name
 *   (a local k3d/k3s test cluster). The image is imported into containerd and
 *   retagged; such images exist only in containerd and are exposed to GC. The
 *   operator must explicitly supply an import command for this mode.
 *
 * Any other reference fails closed: the self-update job never pushes to, or
 * claims delivery through, a registry off this host.
 */
export type KubeImageDelivery =
  | {
    mode: 'registry-push';
    reference: string;
    /** Registry host as written in the reference, e.g. `localhost:19500`. */
    registryHost: string;
    /** Loopback base URL for the registry HTTP API (IPv4, never `localhost`). */
    registryApiBaseUrl: string;
    /** Repository path inside the registry, e.g. `<image-name>`. */
    repository: string;
    tag: string;
  }
  | {
    mode: 'ctr-import';
    reference: string;
    retag: { from: string; to: string };
  };

export type KubeImageDeliveryMode = KubeImageDelivery['mode'];

const LOOPBACK_REGISTRY_HOST_PATTERN = /^(localhost|127\.0\.0\.1):([0-9]{1,5})$/;
const REGISTRY_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function splitTag(reference: string): { name: string; tag: string } {
  if (!isPinnedKubeImageReference(reference)) {
    throw new Error('Kube image delivery requires a pinned image reference.');
  }
  if (reference.includes('@')) {
    throw new Error('Kube image delivery requires a tag reference, not a digest reference.');
  }
  const lastSlash = reference.lastIndexOf('/');
  const lastColon = reference.lastIndexOf(':');
  if (!(lastColon > lastSlash)) {
    throw new Error('Kube image delivery requires an explicit tag.');
  }
  return { name: reference.slice(0, lastColon), tag: reference.slice(lastColon + 1) };
}

/**
 * Encodes the proven k3s import trap: `k3s ctr images import` names the image
 * `docker.io/library/<name>:<tag>`, so it MUST be retagged to
 * `localhost/<name>:<tag>` or the Deployments (which pull `localhost/...`) will
 * not find it. Given the pinned `localhost/...` reference the runtime targets,
 * this returns the import-time source tag and the required destination tag.
 */
export function deriveLocalImportRetag(
  reference: string,
): { from: string; to: string } {
  if (!isPinnedKubeImageReference(reference)) {
    throw new Error('Kube deploy pipeline image retag requires a pinned image reference.');
  }
  const localhostPrefix = 'localhost/';
  if (!reference.startsWith(localhostPrefix)) {
    throw new Error('Kube deploy pipeline expects a localhost/-scoped runtime image reference.');
  }
  const bareName = reference.slice(localhostPrefix.length);
  const lastSlash = bareName.lastIndexOf('/');
  const lastColon = bareName.lastIndexOf(':');
  if (!(lastColon > lastSlash)) {
    throw new Error('Kube deploy pipeline image retag requires an explicit tag.');
  }
  return {
    from: `docker.io/library/${bareName}`,
    to: reference,
  };
}

/** Resolve the delivery mode for a pinned self-update image reference. */
export function deriveKubeImageDelivery(reference: string): KubeImageDelivery {
  const { name, tag } = splitTag(reference);
  const firstSlash = name.indexOf('/');
  const host = firstSlash > 0 ? name.slice(0, firstSlash) : '';
  if (host === 'localhost') {
    return { mode: 'ctr-import', reference, retag: deriveLocalImportRetag(reference) };
  }
  const loopback = LOOPBACK_REGISTRY_HOST_PATTERN.exec(host);
  if (!loopback) {
    throw new Error(
      'Kube image delivery only supports a loopback registry (localhost:<port>/... or 127.0.0.1:<port>/...) '
      + 'or a registry-less localhost/... reference.',
    );
  }
  const port = Number(loopback[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Kube image delivery registry port must be between 1 and 65535.');
  }
  const repository = name.slice(firstSlash + 1);
  if (repository.length === 0) {
    throw new Error('Kube image delivery requires a repository path after the registry host.');
  }
  return {
    mode: 'registry-push',
    reference,
    registryHost: host,
    registryApiBaseUrl: `http://127.0.0.1:${port}`,
    repository,
    tag,
  };
}

/** Pick the digest Docker recorded for this registry repository after a push. */
export function selectPushedRepoDigest(
  delivery: Extract<KubeImageDelivery, { mode: 'registry-push' }>,
  repoDigests: readonly string[],
): string {
  const prefix = `${delivery.registryHost}/${delivery.repository}@`;
  const digests = [...new Set(
    repoDigests.filter(entry => entry.startsWith(prefix)).map(entry => entry.slice(prefix.length)),
  )];
  const digest = digests[0];
  if (digests.length !== 1 || digest === undefined || !REGISTRY_DIGEST_PATTERN.test(digest)) {
    throw new Error(
      `Kube image delivery: docker recorded ${digests.length} pushed digests for ${delivery.reference}; expected exactly one.`,
    );
  }
  return digest;
}

/** Minimal fetch surface so registry verification is testable without a network. */
export type RegistryFetch = (
  url: string,
  init: { method: 'GET' | 'HEAD'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const MANIFEST_MEDIA_TYPES = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

/**
 * Prove through the registry API that the pushed tag resolves to exactly the
 * manifest Docker pushed, and that the manifest's config is the local image.
 * Any mismatch, missing header, or HTTP failure rejects.
 */
export async function verifyRegistryManifest(options: {
  delivery: Extract<KubeImageDelivery, { mode: 'registry-push' }>;
  pushedDigest: string;
  imageId: string;
  fetch: RegistryFetch;
  timeoutMs: number;
}): Promise<{ manifestDigest: string; configDigest: string }> {
  const { delivery, pushedDigest, imageId } = options;
  if (!REGISTRY_DIGEST_PATTERN.test(pushedDigest) || !REGISTRY_DIGEST_PATTERN.test(imageId)) {
    throw new Error('Kube image delivery: pushed digest and image id must be sha256 digests.');
  }
  const manifestsUrl = `${delivery.registryApiBaseUrl}/v2/${delivery.repository}/manifests`;
  const headers = { Accept: MANIFEST_MEDIA_TYPES };

  const byTag = await options.fetch(`${manifestsUrl}/${delivery.tag}`, {
    method: 'HEAD',
    headers,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!byTag.ok) {
    throw new Error(`Kube image delivery: registry did not serve ${delivery.reference} (HTTP ${byTag.status}).`);
  }
  const servedDigest = byTag.headers.get('docker-content-digest')?.trim() ?? '';
  if (servedDigest !== pushedDigest) {
    throw new Error(
      `Kube image delivery: digest mismatch for ${delivery.reference}: registry serves `
      + `${servedDigest || '<none>'}, docker pushed ${pushedDigest}.`,
    );
  }

  const byDigest = await options.fetch(`${manifestsUrl}/${pushedDigest}`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!byDigest.ok) {
    throw new Error(`Kube image delivery: registry did not serve manifest ${pushedDigest} (HTTP ${byDigest.status}).`);
  }
  const manifest = await byDigest.json();
  const config = isRecord(manifest) ? manifest.config : undefined;
  const configDigest = isRecord(config) ? config.digest : undefined;
  if (configDigest !== imageId) {
    throw new Error(
      `Kube image delivery: config digest mismatch for ${delivery.reference}: registry manifest has `
      + `${typeof configDigest === 'string' ? configDigest : '<none>'}, local image is ${imageId}.`,
    );
  }
  return { manifestDigest: servedDigest, configDigest };
}
