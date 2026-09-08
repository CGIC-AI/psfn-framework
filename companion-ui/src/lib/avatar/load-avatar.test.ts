import { describe, expect, it, vi } from 'vitest';
import { loadLocalAvatar } from './load-avatar.js';
import { humanoidModel, modelBuffer, triangleModel } from './model-fixture.js';
import { disposeAvatarScenes } from './resources.js';

function localFile(data: ArrayBuffer): File {
  const file = new File([data], 'avatar.glb');
  // jsdom's File does not implement Blob.arrayBuffer yet.
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(data) });
  return file;
}

describe('Pixiv local model loader', () => {
  it('parses embedded GLB geometry with the actual registered loader', async () => {
    const model = await loadLocalAvatar(localFile(triangleModel()), new AbortController().signal);
    expect(model.vrm).toBeNull();
    expect(model.gltf.scene.children).toHaveLength(1);
    disposeAvatarScenes(model.gltf.scenes);
  });

  it.each(['0', '1'] as const)('loads a VRM %s rig and applies its forward convention', async (version) => {
    const model = await loadLocalAvatar(localFile(humanoidModel(version)), new AbortController().signal);
    expect(model.vrm?.meta.metaVersion).toBe(version);
    expect(model.vrm?.humanoid.getNormalizedBoneNode('head')).toBeTruthy();
    expect(model.gltf.scene.rotation.y).toBe(version === '0' ? Math.PI : 0);
    disposeAvatarScenes(model.gltf.scenes);
  });

  it('rejects external model data without making any fetch', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const data = modelBuffer({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.com/private', byteLength: 4 }] });
      await expect(loadLocalAvatar(localFile(data), new AbortController().signal)).rejects.toThrow(/external files/);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it('honors cancellation after a pending file read', async () => {
    const controller = new AbortController();
    const request = loadLocalAvatar(localFile(triangleModel()), controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});
