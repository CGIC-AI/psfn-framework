import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { disposeAvatarScenes } from './resources.js';

describe('avatar resource disposal', () => {
  it('releases shared geometry, material and texture once across all scenes', () => {
    const geometry = new BoxGeometry();
    const texture = new Texture();
    const material = new MeshStandardMaterial({ map: texture, emissiveMap: texture });
    const root = new Group();
    const second = new Group();
    root.add(new Mesh(geometry, material));
    second.add(new Mesh(geometry, material));
    const parent = new Group();
    parent.add(root, second);
    const freeGeometry = vi.spyOn(geometry, 'dispose');
    const freeMaterial = vi.spyOn(material, 'dispose');
    const freeTexture = vi.spyOn(texture, 'dispose');
    disposeAvatarScenes([root, second]);
    expect(freeGeometry).toHaveBeenCalledOnce();
    expect(freeMaterial).toHaveBeenCalledOnce();
    expect(freeTexture).toHaveBeenCalledOnce();
    expect(parent.children).toHaveLength(0);
  });
});
