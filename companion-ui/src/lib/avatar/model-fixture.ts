/** Small in-memory glTF fixtures; no third-party character assets or network requests. */
export function modelBuffer(document: unknown, binary = new Uint8Array(0)): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const binLength = Math.ceil(binary.length / 4) * 4;
  const result = new ArrayBuffer(20 + jsonLength + (binLength ? 8 + binLength : 0));
  const view = new DataView(result);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, result.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(result, 20, jsonLength).fill(32);
  new Uint8Array(result, 20, text.length).set(text);
  if (binLength) {
    view.setUint32(20 + jsonLength, binLength, true);
    view.setUint32(24 + jsonLength, 0x004e4942, true);
    new Uint8Array(result, 28 + jsonLength, binary.length).set(binary);
  }
  return result;
}

export function triangleModel(): ArrayBuffer {
  return triangleWithExtras();
}

function triangleWithExtras(extra: Record<string, unknown> = {}): ArrayBuffer {
  const vertices = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]);
  return modelBuffer({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [.5, .25, .8, 1], metallicFactor: 0 } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 2, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: vertices.byteLength }],
    buffers: [{ byteLength: vertices.byteLength }],
    ...extra,
  }, new Uint8Array(vertices.buffer));
}

export function humanoidModel(version: '0' | '1'): ArrayBuffer {
  const bones = [
    { name: 'hips', parent: '', translation: [0, 1, 0] },
    { name: 'spine', parent: 'hips', translation: [0, .2, 0] },
    { name: 'chest', parent: 'spine', translation: [0, .2, 0] },
    { name: 'neck', parent: 'chest', translation: [0, .15, 0] },
    { name: 'head', parent: 'neck', translation: [0, .15, 0] },
    { name: 'leftUpperArm', parent: 'chest', translation: [.2, .1, 0] },
    { name: 'leftLowerArm', parent: 'leftUpperArm', translation: [.3, 0, 0] },
    { name: 'leftHand', parent: 'leftLowerArm', translation: [.25, 0, 0] },
    { name: 'rightUpperArm', parent: 'chest', translation: [-.2, .1, 0] },
    { name: 'rightLowerArm', parent: 'rightUpperArm', translation: [-.3, 0, 0] },
    { name: 'rightHand', parent: 'rightLowerArm', translation: [-.25, 0, 0] },
    { name: 'leftUpperLeg', parent: 'hips', translation: [.1, -.1, 0] },
    { name: 'leftLowerLeg', parent: 'leftUpperLeg', translation: [0, -.4, 0] },
    { name: 'leftFoot', parent: 'leftLowerLeg', translation: [0, -.4, 0] },
    { name: 'rightUpperLeg', parent: 'hips', translation: [-.1, -.1, 0] },
    { name: 'rightLowerLeg', parent: 'rightUpperLeg', translation: [0, -.4, 0] },
    { name: 'rightFoot', parent: 'rightLowerLeg', translation: [0, -.4, 0] },
  ];
  const humanBones = bones.map((bone, index) => ({ bone: bone.name, node: index + 1 }));
  const extension = version === '0' ? 'VRM' : 'VRMC_vrm';
  const description = version === '0' ? {
    specVersion: '0.0', meta: { title: 'Fixture', author: 'Fixture', licenseName: 'CC0' },
    humanoid: { humanBones },
  } : {
    specVersion: '1.0', meta: { name: 'Fixture', authors: ['Fixture'], licenseUrl: 'https://vrm.dev/licenses/1.0/' },
    humanoid: { humanBones: Object.fromEntries(humanBones.map(({ bone, node }) => [bone, { node }])) },
  };
  return triangleWithExtras({
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0 }, ...bones.map((bone) => ({
      name: bone.name, translation: bone.translation,
      children: bones.flatMap((child, index) => child.parent === bone.name ? [index + 1] : []),
    }))],
    extensionsUsed: [extension], extensions: { [extension]: description },
  });
}
