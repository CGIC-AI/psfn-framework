import { describe, expect, it } from 'vitest';
import {
  deriveKubeImageDelivery,
  deriveLocalImportRetag,
  selectPushedRepoDigest,
  verifyRegistryManifest,
  type KubeImageDelivery,
  type RegistryFetch,
} from './kube-image-delivery.js';

const MANIFEST = `sha256:${'1'.repeat(64)}`;
const OTHER_MANIFEST = `sha256:${'2'.repeat(64)}`;
const IMAGE_ID = `sha256:${'3'.repeat(64)}`;

type RegistryDelivery = Extract<KubeImageDelivery, { mode: 'registry-push' }>;

function registryDelivery(reference = 'localhost:19500/psfn-framework:0.1.0-kube-aaaaaaaa'): RegistryDelivery {
  const delivery = deriveKubeImageDelivery(reference);
  if (delivery.mode !== 'registry-push') throw new Error('expected registry-push');
  return delivery;
}

function fakeRegistry(options: {
  tagDigest?: string | null;
  tagStatus?: number;
  configDigest?: string;
}): { fetch: RegistryFetch; requests: Array<{ url: string; method: string; accept: string }> } {
  const requests: Array<{ url: string; method: string; accept: string }> = [];
  const fetch: RegistryFetch = async (url, init) => {
    requests.push({ url, method: init.method, accept: init.headers.Accept ?? '' });
    if (init.method === 'HEAD') {
      const status = options.tagStatus ?? 200;
      return {
        ok: status === 200,
        status,
        headers: { get: name => (name === 'docker-content-digest' ? options.tagDigest ?? null : null) },
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ config: { digest: options.configDigest ?? IMAGE_ID } }),
    };
  };
  return { fetch, requests };
}

describe('deriveKubeImageDelivery', () => {
  it('delivers a loopback-registry reference by registry push', () => {
    expect(deriveKubeImageDelivery('localhost:19500/psfn-framework:0.1.0-kube-aaaaaaaa')).toEqual({
      mode: 'registry-push',
      reference: 'localhost:19500/psfn-framework:0.1.0-kube-aaaaaaaa',
      registryHost: 'localhost:19500',
      registryApiBaseUrl: 'http://127.0.0.1:19500',
      repository: 'psfn-framework',
      tag: '0.1.0-kube-aaaaaaaa',
    });
    expect(deriveKubeImageDelivery('127.0.0.1:19500/team/psfn-framework:0.1.0-kube-aaaaaaaa')).toMatchObject({
      mode: 'registry-push',
      registryHost: '127.0.0.1:19500',
      repository: 'team/psfn-framework',
    });
  });

  it('keeps registry-less localhost/ references on the containerd import retag', () => {
    expect(deriveKubeImageDelivery('localhost/psfn-framework:0.1.0-kube-aaaaaaaa')).toEqual({
      mode: 'ctr-import',
      reference: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaa',
      retag: {
        from: 'docker.io/library/psfn-framework:0.1.0-kube-aaaaaaaa',
        to: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaa',
      },
    });
  });

  it('fails closed on off-host registries, floating tags, digests, and bad ports', () => {
    expect(() => deriveKubeImageDelivery('registry.example.com/psfn-framework:1.0')).toThrow('loopback registry');
    expect(() => deriveKubeImageDelivery('docker.io/library/psfn-framework:1.0')).toThrow('loopback registry');
    expect(() => deriveKubeImageDelivery('psfn-framework:1.0')).toThrow('loopback registry');
    expect(() => deriveKubeImageDelivery('10.0.0.5:19500/psfn-framework:1.0')).toThrow('loopback registry');
    expect(() => deriveKubeImageDelivery('localhost:19500/psfn-framework:latest')).toThrow('pinned');
    expect(() => deriveKubeImageDelivery('localhost:19500/psfn-framework')).toThrow('pinned');
    expect(() => deriveKubeImageDelivery(`localhost:19500/psfn-framework:1.0@${MANIFEST}`)).toThrow('not a digest');
    expect(() => deriveKubeImageDelivery('localhost:0/psfn-framework:1.0')).toThrow('between 1 and 65535');
    expect(() => deriveKubeImageDelivery('localhost:70000/psfn-framework:1.0')).toThrow('between 1 and 65535');
  });
});

describe('deriveLocalImportRetag', () => {
  it('maps the containerd import name to the localhost runtime tag', () => {
    expect(deriveLocalImportRetag('localhost/psfn-framework:0.1.0-kube-aaaaaaaa')).toEqual({
      from: 'docker.io/library/psfn-framework:0.1.0-kube-aaaaaaaa',
      to: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaa',
    });
  });

  it('rejects floating tags and non-localhost references', () => {
    expect(() => deriveLocalImportRetag('localhost/psfn-framework:latest')).toThrow('pinned');
    expect(() => deriveLocalImportRetag('docker.io/library/psfn-framework:1.0'))
      .toThrow('localhost/-scoped');
  });
});

describe('selectPushedRepoDigest', () => {
  it('selects the digest Docker recorded for exactly this registry repository', () => {
    expect(selectPushedRepoDigest(registryDelivery(), [
      `localhost/psfn-framework@${OTHER_MANIFEST}`,
      `localhost:19500/psfn-framework@${MANIFEST}`,
    ])).toBe(MANIFEST);
  });

  it('rejects zero or conflicting pushed digests', () => {
    expect(() => selectPushedRepoDigest(registryDelivery(), [])).toThrow('0 pushed digests');
    expect(() => selectPushedRepoDigest(registryDelivery(), [
      `localhost:19500/psfn-framework@${MANIFEST}`,
      `localhost:19500/psfn-framework@${OTHER_MANIFEST}`,
    ])).toThrow('2 pushed digests');
  });
});

describe('verifyRegistryManifest', () => {
  it('passes when the tag serves the pushed manifest whose config is the local image', async () => {
    const registry = fakeRegistry({ tagDigest: MANIFEST });
    await expect(verifyRegistryManifest({
      delivery: registryDelivery(),
      pushedDigest: MANIFEST,
      imageId: IMAGE_ID,
      fetch: registry.fetch,
      timeoutMs: 1_000,
    })).resolves.toEqual({ manifestDigest: MANIFEST, configDigest: IMAGE_ID });
    expect(registry.requests.map(request => `${request.method} ${request.url}`)).toEqual([
      'HEAD http://127.0.0.1:19500/v2/psfn-framework/manifests/0.1.0-kube-aaaaaaaa',
      `GET http://127.0.0.1:19500/v2/psfn-framework/manifests/${MANIFEST}`,
    ]);
    expect(registry.requests[0]?.accept).toContain('application/vnd.oci.image.manifest.v1+json');
  });

  it('fails when the registry serves a different manifest digest for the tag', async () => {
    const registry = fakeRegistry({ tagDigest: OTHER_MANIFEST });
    await expect(verifyRegistryManifest({
      delivery: registryDelivery(),
      pushedDigest: MANIFEST,
      imageId: IMAGE_ID,
      fetch: registry.fetch,
      timeoutMs: 1_000,
    })).rejects.toThrow(/digest mismatch.*registry serves sha256:2+, docker pushed sha256:1+/);
  });

  it('fails when the tag is missing or the digest header is absent', async () => {
    await expect(verifyRegistryManifest({
      delivery: registryDelivery(),
      pushedDigest: MANIFEST,
      imageId: IMAGE_ID,
      fetch: fakeRegistry({ tagStatus: 404 }).fetch,
      timeoutMs: 1_000,
    })).rejects.toThrow('HTTP 404');
    await expect(verifyRegistryManifest({
      delivery: registryDelivery(),
      pushedDigest: MANIFEST,
      imageId: IMAGE_ID,
      fetch: fakeRegistry({ tagDigest: null }).fetch,
      timeoutMs: 1_000,
    })).rejects.toThrow('registry serves <none>');
  });

  it('fails when the manifest config is not the local image', async () => {
    await expect(verifyRegistryManifest({
      delivery: registryDelivery(),
      pushedDigest: MANIFEST,
      imageId: IMAGE_ID,
      fetch: fakeRegistry({ tagDigest: MANIFEST, configDigest: OTHER_MANIFEST }).fetch,
      timeoutMs: 1_000,
    })).rejects.toThrow('config digest mismatch');
  });
});
