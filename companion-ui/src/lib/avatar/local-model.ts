import { isObjectRecord as isRecord } from '../../../../src/shared/utils/types.js';

// Browser memory protection for an explicitly selected local asset, not a runtime setting.
const LOCAL_MODEL_BYTES = 128 * 1024 * 1024;
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const EMBEDDED_RESOURCE = /^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp|avif));base64,[a-zA-Z0-9+/]*={0,2}$/;
// Required extensions must have a decoder in the bundled Three/Pixiv loader.
const MODEL_EXTENSIONS = new Set([
  'VRM', 'VRMC_vrm', 'VRMC_springBone', 'VRMC_node_constraint',
  'VRMC_materials_mtoon', 'VRMC_materials_hdr_emissiveMultiplier',
  'KHR_lights_punctual', 'KHR_materials_anisotropy', 'KHR_materials_clearcoat',
  'KHR_materials_dispersion', 'KHR_materials_emissive_strength', 'KHR_materials_ior',
  'KHR_materials_iridescence', 'KHR_materials_sheen', 'KHR_materials_specular',
  'KHR_materials_transmission', 'KHR_materials_unlit', 'KHR_materials_volume',
  'KHR_mesh_quantization', 'KHR_texture_transform', 'EXT_materials_bump',
  'EXT_meshopt_compression', 'EXT_mesh_gpu_instancing', 'EXT_texture_avif', 'EXT_texture_webp',
]);

export class LocalAvatarError extends Error {
  override name = 'LocalAvatarError';
}

export function validateLocalAvatarFile(file: Pick<File, 'name' | 'size'>): void {
  if (!/\.(?:vrm|glb)$/i.test(file.name)) {
    throw new LocalAvatarError('Choose a .vrm or .glb model with its textures embedded.');
  }
  if (file.size === 0 || file.size > LOCAL_MODEL_BYTES) {
    throw new LocalAvatarError('Choose a non-empty model smaller than 128 MB.');
  }
}

/** Inspect the binary container before any loader can request its dependencies. */
export function inspectLocalAvatar(data: ArrayBuffer): { hasVrm: boolean } {
  const view = new DataView(data);
  if (data.byteLength < 20 || data.byteLength > LOCAL_MODEL_BYTES
    || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== data.byteLength) {
    throw new LocalAvatarError('This file is not a valid binary VRM or GLB model.');
  }
  let document: unknown;
  let offset = 12;
  let hasBinary = false;
  while (offset < data.byteLength) {
    if (offset + 8 > data.byteLength) throw new LocalAvatarError('The model contains a truncated chunk.');
    const length = view.getUint32(offset, true);
    const kind = view.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (length % 4 !== 0 || end > data.byteLength) throw new LocalAvatarError('The model contains a damaged chunk.');
    if (offset === 12 && kind !== JSON_CHUNK) throw new LocalAvatarError('The model is missing its description.');
    if (kind === JSON_CHUNK) {
      if (document !== undefined) throw new LocalAvatarError('The model contains duplicate descriptions.');
      try {
        document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(data, offset + 8, length)));
      } catch {
        throw new LocalAvatarError('The model description is not valid JSON.');
      }
    } else if (kind === BIN_CHUNK) {
      if (hasBinary) throw new LocalAvatarError('The model contains duplicate binary data.');
      hasBinary = true;
    }
    offset = end;
  }
  if (!isRecord(document) || !isRecord(document.asset) || document.asset.version !== '2.0') {
    throw new LocalAvatarError('This player supports glTF 2.0 models only.');
  }

  // Includes extension-owned URI fields. A supplied blob URL is also external to this file.
  const pending: unknown[] = [document];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) { for (const child of value) pending.push(child); }
    else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'uri' && (typeof child !== 'string' || !EMBEDDED_RESOURCE.test(child))) {
          throw new LocalAvatarError('This model references external files. Export a VRM or GLB with embedded textures and buffers.');
        }
        if (typeof child === 'object' && child !== null) pending.push(child);
      }
    }
  }
  const required = document.extensionsRequired;
  if (required !== undefined && (!Array.isArray(required) || required.some((value) => typeof value !== 'string'))) {
    throw new LocalAvatarError('The model has an invalid extension list.');
  }
  if (Array.isArray(required) && required.some((value) => value === 'KHR_draco_mesh_compression' || value === 'KHR_texture_basisu')) {
    throw new LocalAvatarError('Re-export this model without Draco geometry or KTX2 textures to use it here.');
  }
  if (Array.isArray(required) && required.some((value) => !MODEL_EXTENSIONS.has(value))) {
    throw new LocalAvatarError('This model requires an unsupported extension. Try a standard VRM or GLB export.');
  }
  return { hasVrm: isRecord(document.extensions) && ('VRM' in document.extensions || 'VRMC_vrm' in document.extensions) };
}

/** Only loader-created object URLs and embedded data can reach browser loaders. */
export function localAvatarResourceUrl(url: string): string {
  if (url.startsWith('blob:') || EMBEDDED_RESOURCE.test(url)) return url;
  throw new LocalAvatarError('The model attempted to load an external resource.');
}
