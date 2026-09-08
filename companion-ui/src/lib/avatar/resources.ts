import {
  BufferGeometry, Material, Mesh, Line, Points, ShaderMaterial,
  Skeleton, SkinnedMesh, Texture, type Object3D,
} from 'three';

/** Dispose shared resources once, including decoded images and skinning textures. */
export function disposeAvatarScenes(roots: readonly Object3D[]): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const skeletons = new Set<Skeleton>();
  for (const root of roots) {
    root.traverse((object) => {
      if (object instanceof Mesh || object instanceof Line || object instanceof Points) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
      if (object instanceof SkinnedMesh) skeletons.add(object.skeleton);
    });
    root.removeFromParent();
  }
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    if (material instanceof ShaderMaterial) {
      for (const uniform of Object.values(material.uniforms)) {
        if (uniform.value instanceof Texture) textures.add(uniform.value);
      }
    }
    material.dispose();
  }
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    const image: unknown = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) images.add(image);
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}
