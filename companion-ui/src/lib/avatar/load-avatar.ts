import { LoadingManager } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { inspectLocalAvatar, localAvatarResourceUrl, LocalAvatarError, validateLocalAvatarFile } from './local-model.js';
import { disposeAvatarScenes } from './resources.js';

export async function loadLocalAvatar(file: File, signal: AbortSignal) {
  validateLocalAvatarFile(file);
  const data = await file.arrayBuffer();
  signal.throwIfAborted();
  const { hasVrm } = inspectLocalAvatar(data);
  const blobs = new Set<string>();
  const manager = new LoadingManager();
  let failedResource = false;
  manager.onError = () => { failedResource = true; };
  manager.setURLModifier((url) => {
    const safeUrl = localAvatarResourceUrl(url);
    if (safeUrl.startsWith('blob:')) blobs.add(safeUrl);
    return safeUrl;
  });
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  let gltf: GLTF | undefined;
  // Capture decoded resources before the VRM plugin validates metadata or the rig.
  loader.register(() => ({
    name: 'LocalAvatarResources',
    afterRoot(result) { gltf = result; return null; },
  }));
  loader.register((parser) => new VRMLoaderPlugin(parser));
  try {
    gltf = await loader.parseAsync(data, '');
    signal.throwIfAborted();
    if (failedResource) throw new LocalAvatarError('A model texture or buffer could not be decoded. Try re-exporting the model.');
    const vrm = gltf.userData.vrm instanceof VRM ? gltf.userData.vrm : null;
    if (hasVrm && !vrm) throw new LocalAvatarError('The VRM is missing a supported humanoid or model description.');
    if (vrm) {
      VRMUtils.rotateVRM0(vrm);
      // Match Pixiv's mobile-friendly baseline without changing non-VRM morph clips.
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
      VRMUtils.combineSkeletons(vrm.scene);
      if (gltf.animations.length === 0) VRMUtils.combineMorphs(vrm);
      vrm.scene.traverse((object) => { object.frustumCulled = false; });
    }
    return { gltf, vrm };
  } catch (error) {
    if (gltf) disposeAvatarScenes(gltf.scenes);
    throw error;
  } finally {
    for (const url of blobs) URL.revokeObjectURL(url);
  }
}
