import { describe, expect, it } from 'vitest';
import { inspectLocalAvatar, localAvatarResourceUrl, validateLocalAvatarFile } from './local-model.js';
import { modelBuffer, triangleModel } from './model-fixture.js';

describe('local avatar boundary', () => {
  it('accepts GLB geometry and recognizes both VRM extension generations', () => {
    expect(inspectLocalAvatar(triangleModel())).toEqual({ hasVrm: false });
    for (const extension of ['VRM', 'VRMC_vrm']) {
      expect(inspectLocalAvatar(modelBuffer({ asset: { version: '2.0' }, extensions: { [extension]: {} } }))).toEqual({ hasVrm: true });
    }
  });

  it.each(['https://example.com/texture.png', '//example.com/x', '/api/private', '../texture.png', 'blob:https://example.com/other', 'data:image/svg+xml;base64,PHN2Zz4='])('rejects referenced URI %s before loading', (uri) => {
    expect(() => inspectLocalAvatar(modelBuffer({ asset: { version: '2.0' }, images: [{ uri }] }))).toThrow(/external files/);
  });

  it('checks extension-owned URIs and allows embedded raster textures', () => {
    expect(() => inspectLocalAvatar(modelBuffer({ asset: { version: '2.0' }, extensions: { extra: { nested: [{ uri: '/private' }] } } }))).toThrow(/external files/);
    expect(inspectLocalAvatar(modelBuffer({ asset: { version: '2.0' }, images: [{ uri: 'data:image/png;base64,YQ==' }] }))).toEqual({ hasVrm: false });
  });

  it('rejects truncated containers, unsupported versions, and mismatched byte lengths', () => {
    expect(() => inspectLocalAvatar(new ArrayBuffer(8))).toThrow(/valid binary/);
    const data = triangleModel();
    new DataView(data).setUint32(8, data.byteLength - 1, true);
    expect(() => inspectLocalAvatar(data)).toThrow(/valid binary/);
    expect(() => inspectLocalAvatar(modelBuffer({ asset: { version: '1.0' } }))).toThrow(/2.0/);
  });

  it('rejects unknown required extensions and missing compression decoders', () => {
    for (const extension of ['KHR_draco_mesh_compression', 'KHR_texture_basisu', 'UNKNOWN_required']) {
      expect(() => inspectLocalAvatar(modelBuffer({ asset: { version: '2.0' }, extensionsRequired: [extension] }))).toThrow(/Re-export|unsupported extension/);
    }
  });

  it('validates filenames and bounded file size', () => {
    expect(() => validateLocalAvatarFile({ name: 'avatar.VRM', size: 100 })).not.toThrow();
    expect(() => validateLocalAvatarFile({ name: 'avatar.gltf', size: 100 })).toThrow(/\.vrm or \.glb/);
    expect(() => validateLocalAvatarFile({ name: 'avatar.vrm', size: 0 })).toThrow(/128 MB/);
    expect(() => validateLocalAvatarFile({ name: 'avatar.vrm', size: 129 * 1024 * 1024 })).toThrow(/128 MB/);
  });

  it('blocks network resource loading even after inspection', () => {
    expect(localAvatarResourceUrl('blob:generated-local-texture')).toBe('blob:generated-local-texture');
    expect(() => localAvatarResourceUrl('https://example.com/texture')).toThrow(/external resource/);
  });
});
