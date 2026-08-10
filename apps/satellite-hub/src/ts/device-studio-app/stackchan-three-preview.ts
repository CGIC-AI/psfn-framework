import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import {
  stackChanModelManifest,
  type ModelPart,
  type ModelPivot,
  type StackChanModelManifest,
} from "../device-studio/assets.js";
import type { StackChanPreviewModel } from "./stackchan-preview.js";

export interface StackChanThreeRigPlan {
  renderer: "three";
  profileId: string;
  coordinateSystem: StackChanModelManifest["coordinateSystem"];
  parts: Array<{
    id: string;
    role: ModelPart["role"];
    pivotId?: string;
    bounds: ModelPart["fallback"]["bounds"];
  }>;
  pivots: Array<{
    id: string;
    jointId?: string;
    parentPartId: string;
    childPartIds: string[];
    origin: ModelPivot["origin"];
    axis: ModelPivot["axis"];
  }>;
  cadAssets: Array<{
    id: string;
    path: string;
    mount: CaseStlAsset["mount"];
    target: CaseStlAsset["target"];
  }>;
}

export interface StackChanThreePose {
  yawRadians: number;
  pitchRadians: number;
  headYawDegrees: number;
  headPitchDegrees: number;
  leftEyeScaleY: number;
  rightEyeScaleY: number;
  mouthScaleX: number;
  mouthScaleY: number;
  ledColor: string;
}

const MILLIMETERS_TO_SCENE_UNITS = 1 / 35;
const CAMERA_TARGET = new THREE.Vector3(0, 2.05, 0);
const STL_TO_DEVICE_ROTATION_X = -Math.PI / 2;
type CaseStlMount = "rig" | "yaw" | "pitch";
interface CaseStlTarget {
  bounds: { width: number; height: number; depth: number };
  origin: { x: number; y: number; z: number };
}
interface CaseStlAsset {
  id: string;
  path: string;
  color: string;
  mount: CaseStlMount;
  target: CaseStlTarget;
}
const CASE_STL_ASSETS = [
  {
    id: "case.shell",
    path: "assets/stackchan/source/shell.stl",
    color: "#8f9a9b",
    mount: "pitch",
    target: { bounds: { width: 70, height: 54, depth: 50 }, origin: { x: 0, y: 86, z: 0 } },
  },
  {
    id: "feet.top",
    path: "assets/stackchan/source/feet_top.stl",
    color: "#d3dcda",
    mount: "rig",
    target: { bounds: { width: 62, height: 16, depth: 50 }, origin: { x: 0, y: 12, z: 0 } },
  },
  {
    id: "feet.bottom",
    path: "assets/stackchan/source/feet_bottom.stl",
    color: "#aebaba",
    mount: "rig",
    target: { bounds: { width: 58, height: 10, depth: 46 }, origin: { x: 0, y: 5, z: 0 } },
  },
  {
    id: "bracket.front",
    path: "assets/stackchan/source/bracket_XL330_f.stl",
    color: "#7f8a8d",
    mount: "yaw",
    target: { bounds: { width: 28, height: 40, depth: 12 }, origin: { x: 0, y: 58, z: 18 } },
  },
  {
    id: "bracket.back",
    path: "assets/stackchan/source/bracket_XL330_b.stl",
    color: "#687376",
    mount: "yaw",
    target: { bounds: { width: 28, height: 40, depth: 12 }, origin: { x: 0, y: 58, z: -18 } },
  },
  {
    id: "tilt.horn",
    path: "assets/stackchan/source/horn.stl",
    color: "#c4ccce",
    mount: "pitch",
    target: { bounds: { width: 36, height: 16, depth: 28 }, origin: { x: 0, y: 81, z: -24 } },
  },
] as const satisfies readonly CaseStlAsset[];

export function createStackChanThreeRigPlan(
  manifest: StackChanModelManifest = stackChanModelManifest,
): StackChanThreeRigPlan {
  return {
    renderer: "three",
    profileId: manifest.profileId,
    coordinateSystem: manifest.coordinateSystem,
    parts: manifest.parts.map((part) => ({
      id: part.id,
      role: part.role,
      ...(part.pivotId ? { pivotId: part.pivotId } : {}),
      bounds: part.fallback.bounds,
    })),
    pivots: manifest.pivots.map((pivot) => ({
      id: pivot.id,
      ...(pivot.jointId ? { jointId: pivot.jointId } : {}),
      parentPartId: pivot.parentPartId,
      childPartIds: [...pivot.childPartIds],
      origin: { ...pivot.origin },
      axis: { ...pivot.axis },
    })),
    cadAssets: CASE_STL_ASSETS.map((asset) => ({
      id: asset.id,
      path: asset.path,
      mount: asset.mount,
      target: {
        bounds: { ...asset.target.bounds },
        origin: { ...asset.target.origin },
      },
    })),
  };
}

export function createStackChanThreePose(model: StackChanPreviewModel): StackChanThreePose {
  const mouth = mouthScale(model.mouthMode);
  return {
    yawRadians: THREE.MathUtils.degToRad(model.yawDegrees),
    pitchRadians: THREE.MathUtils.degToRad(-model.pitchDegrees),
    headYawDegrees: model.yawDegrees,
    headPitchDegrees: model.pitchDegrees,
    leftEyeScaleY: eyeScaleY(model.leftEyeMode),
    rightEyeScaleY: eyeScaleY(model.rightEyeMode),
    mouthScaleX: mouth.x,
    mouthScaleY: mouth.y,
    ledColor: model.ledColor,
  };
}

export class StackChanThreePreview {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  private readonly rig = new THREE.Group();
  private readonly requiredAssembly = new THREE.Group();
  private readonly yawGroup = new THREE.Group();
  private readonly pitchGroup = new THREE.Group();
  private readonly eyeMaterial = new THREE.MeshBasicMaterial({ color: "#e8fbf6" });
  private readonly mouthMaterial = new THREE.MeshBasicMaterial({ color: "#e8fbf6" });
  private readonly screenMaterial = new THREE.MeshStandardMaterial({
    color: "#101918",
    emissive: "#101918",
    emissiveIntensity: 0.85,
    roughness: 0.34,
    metalness: 0.08,
  });
  private readonly ledMaterial = new THREE.MeshStandardMaterial({
    color: "#50d6c6",
    emissive: "#50d6c6",
    emissiveIntensity: 1.2,
    roughness: 0.4,
    metalness: 0.08,
  });
  private readonly leftEye: THREE.Mesh;
  private readonly rightEye: THREE.Mesh;
  private readonly mouth: THREE.Mesh;
  private readonly ledMeshes: THREE.Mesh[] = [];
  private readonly resizeObserver: ResizeObserver;
  private disposed = false;
  private lastPose: StackChanThreePose | undefined;
  private animationFrameId: number | undefined;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.canvas = this.renderer.domElement;
    this.canvas.className = "stackchan-three-canvas";
    this.canvas.dataset.threeStackchan = "true";
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.addEventListener("webglcontextlost", this.handleWebglContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.handleWebglContextRestored);
    this.host.dataset.cad = "loading";
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.leftEye = this.createFacePlane(0.4, 0.18, this.eyeMaterial);
    this.rightEye = this.createFacePlane(0.4, 0.18, this.eyeMaterial);
    this.mouth = this.createFacePlane(0.44, 0.22, this.mouthMaterial);

    this.host.replaceChildren(this.canvas);
    this.buildScene();
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(this.host);
    this.render();
    this.scheduleRenderLoop();
  }

  update(model: StackChanPreviewModel): void {
    const pose = createStackChanThreePose(model);
    this.lastPose = pose;
    this.yawGroup.rotation.y = pose.yawRadians;
    this.pitchGroup.rotation.x = pose.pitchRadians;

    this.leftEye.scale.y = pose.leftEyeScaleY;
    this.rightEye.scale.y = pose.rightEyeScaleY;
    this.mouth.scale.set(pose.mouthScaleX, pose.mouthScaleY, 1);
    this.screenMaterial.color.set(model.screenBackground);
    this.screenMaterial.emissive.set(model.screenBackground);
    this.ledMaterial.color.set(pose.ledColor);
    this.ledMaterial.emissive.set(pose.ledColor);

    this.render();
  }

  snapshot(): StackChanThreePose | undefined {
    return this.lastPose ? { ...this.lastPose } : undefined;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.animationFrameId !== undefined) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("webglcontextlost", this.handleWebglContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleWebglContextRestored);
    this.renderer.dispose();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
      }
    });
    for (const material of [
      this.eyeMaterial,
      this.mouthMaterial,
      this.screenMaterial,
      this.ledMaterial,
      ...collectRigMaterials(this.rig),
    ]) {
      material.dispose();
    }
  }

  private buildScene(): void {
    this.scene.background = new THREE.Color("#eaf2f6");
    this.scene.add(new THREE.HemisphereLight("#ffffff", "#8f9aa2", 2.1));

    const keyLight = new THREE.DirectionalLight("#ffffff", 2.4);
    keyLight.position.set(4, 6, 6);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight("#c4edf2", 0.9);
    fillLight.position.set(-3, 2.5, 4);
    this.scene.add(fillLight);

    this.camera.position.set(3.9, 2.95, 6.1);
    this.camera.lookAt(CAMERA_TARGET);

    this.rig.rotation.y = -0.32;
    this.rig.position.y = -0.95;
    this.scene.add(this.rig);
    this.requiredAssembly.visible = false;
    this.rig.add(this.requiredAssembly);

    const yawPivot = requirePivot("pivot.head.yaw");
    const pitchPivot = requirePivot("pivot.head.pitch");
    this.yawGroup.position.copy(toSceneVector(yawPivot.origin));
    this.pitchGroup.position.copy(toSceneVector(pitchPivot.origin).sub(toSceneVector(yawPivot.origin)));

    this.requiredAssembly.add(this.createServoBody({
      bounds: { width: 24, height: 28, depth: 30 },
      origin: { x: 0, y: 36, z: 0 },
      color: "#20272a",
    }));
    this.requiredAssembly.add(this.createServoAxisMarker({
      radius: 9,
      length: 7,
      origin: yawPivot.origin,
      axis: "yaw",
      color: "#c9d2d4",
    }));
    this.requiredAssembly.add(this.createLedStrip());
    this.requiredAssembly.add(this.yawGroup);
    this.yawGroup.add(this.createServoBody({
      bounds: { width: 24, height: 24, depth: 26 },
      origin: { x: 0, y: 67, z: 0 },
      color: "#2b3337",
      relativeTo: yawPivot.origin,
    }));
    this.yawGroup.add(this.createServoAxisMarker({
      radius: 7,
      length: 34,
      origin: pitchPivot.origin,
      axis: "pitch",
      color: "#d3dbdd",
      relativeTo: yawPivot.origin,
    }));
    this.yawGroup.add(this.pitchGroup);
    this.pitchGroup.add(this.createDisplayAssembly(pitchPivot));

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(2.8, 48),
      new THREE.MeshStandardMaterial({
        color: "#d6e1e3",
        roughness: 0.78,
        metalness: 0,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.04;
    this.rig.add(floor);

    void this.loadCaseStlAssets().catch((error: unknown) => {
      this.host.dataset.cad = "error";
      this.requiredAssembly.visible = false;
      console.error(error);
      this.render();
    });
  }

  private createDisplayAssembly(pitchPivot: ModelPivot): THREE.Object3D {
    const display = requirePart("display.face");
    const group = new THREE.Group();
    group.position.copy(toSceneVector(display.fallback.origin).sub(toSceneVector(pitchPivot.origin)));

    const bounds = display.fallback.bounds;
    const displayMesh = new THREE.Mesh(
      new THREE.BoxGeometry(mm(bounds.width), mm(bounds.height), mm(bounds.depth)),
      this.screenMaterial,
    );
    group.add(displayMesh);

    const faceOffsetZ = mm(bounds.depth / 2) + 0.012;
    this.leftEye.position.set(mm(-13), mm(6), faceOffsetZ);
    this.rightEye.position.set(mm(13), mm(6), faceOffsetZ);
    this.mouth.position.set(0, mm(-9), faceOffsetZ + 0.002);
    group.add(this.leftEye, this.rightEye, this.mouth);

    return group;
  }

  private createServoBody(options: {
    bounds: { width: number; height: number; depth: number };
    origin: { x: number; y: number; z: number };
    color: string;
    relativeTo?: { x: number; y: number; z: number };
  }): THREE.Object3D {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(mm(options.bounds.width), mm(options.bounds.height), mm(options.bounds.depth)),
      new THREE.MeshStandardMaterial({
        color: options.color,
        roughness: 0.5,
        metalness: 0.12,
      }),
    );
    const origin = toSceneVector(options.origin);
    const relativeTo = options.relativeTo ? toSceneVector(options.relativeTo) : new THREE.Vector3();
    mesh.position.copy(origin.sub(relativeTo));
    return mesh;
  }

  private createServoAxisMarker(options: {
    radius: number;
    length: number;
    origin: { x: number; y: number; z: number };
    axis: "yaw" | "pitch";
    color: string;
    relativeTo?: { x: number; y: number; z: number };
  }): THREE.Object3D {
    const geometry = new THREE.CylinderGeometry(mm(options.radius), mm(options.radius), mm(options.length), 32);
    if (options.axis === "pitch") {
      geometry.rotateZ(Math.PI / 2);
    }
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: options.color,
        roughness: 0.46,
        metalness: 0.18,
      }),
    );
    const origin = toSceneVector(options.origin);
    const relativeTo = options.relativeTo ? toSceneVector(options.relativeTo) : new THREE.Vector3();
    mesh.position.copy(origin.sub(relativeTo));
    return mesh;
  }

  private async loadCaseStlAssets(): Promise<void> {
    const loader = new STLLoader();
    const loaded = await Promise.all(CASE_STL_ASSETS.map(async (asset) => {
      const geometry = await loader.loadAsync(asset.path);
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: asset.color,
          roughness: 0.62,
          metalness: 0.03,
          side: THREE.DoubleSide,
        }),
      );
      mesh.name = asset.id;
      return placeStlMesh(mesh, asset);
    }));

    for (const { asset, mesh } of loaded) {
      this.mountForAsset(asset).add(mesh);
    }
    this.requiredAssembly.visible = true;
    this.host.dataset.cad = "loaded";
    this.render();
  }

  private mountForAsset(asset: CaseStlAsset): THREE.Group {
    switch (asset.mount) {
      case "pitch":
        return this.pitchGroup;
      case "yaw":
        return this.yawGroup;
      case "rig":
        return this.requiredAssembly;
    }
  }

  private createLedStrip(): THREE.Object3D {
    const ledPart = requirePart("status.rgb");
    const group = new THREE.Group();
    const origin = toSceneVector(ledPart.fallback.origin);
    const spacing = mm(9);
    for (let index = 0; index < 5; index += 1) {
      const led = new THREE.Mesh(new THREE.SphereGeometry(mm(2.7), 16, 10), this.ledMaterial);
      led.position.set(origin.x + ((index - 2) * spacing), origin.y, origin.z + mm(2.1));
      this.ledMeshes.push(led);
      group.add(led);
    }
    return group;
  }

  private createFacePlane(width: number, height: number, material: THREE.MeshBasicMaterial): THREE.Mesh {
    return new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  }

  private readonly handleWebglContextLost = (event: Event): void => {
    event.preventDefault();
  };

  private readonly handleWebglContextRestored = (): void => {
    requestAnimationFrame(() => this.render());
  };

  private scheduleRenderLoop(): void {
    this.animationFrameId = requestAnimationFrame(() => {
      this.animationFrameId = undefined;
      this.render();
      if (!this.disposed) {
        this.scheduleRenderLoop();
      }
    });
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }
}

function placeStlMesh(mesh: THREE.Mesh, asset: CaseStlAsset): { asset: CaseStlAsset; mesh: THREE.Mesh } {
  mesh.rotation.x = STL_TO_DEVICE_ROTATION_X;
  mesh.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  if (size.x <= 0 || size.y <= 0 || size.z <= 0) {
    throw new Error(`Stack-chan STL asset ${asset.path} has invalid bounds`);
  }

  const target = asset.target.bounds;
  const scale = Math.min(
    mm(target.width) / size.x,
    mm(target.height) / size.y,
    mm(target.depth) / size.z,
  );
  mesh.scale.setScalar(scale);

  const targetOrigin = toSceneVector(asset.target.origin);
  const mountOrigin = asset.mount === "pitch"
    ? toSceneVector(requirePivot("pivot.head.pitch").origin)
    : asset.mount === "yaw"
      ? toSceneVector(requirePivot("pivot.head.yaw").origin)
      : new THREE.Vector3();
  mesh.position.set(
    targetOrigin.x - mountOrigin.x - (center.x * scale),
    targetOrigin.y - mountOrigin.y - (center.y * scale),
    targetOrigin.z - mountOrigin.z - (center.z * scale),
  );

  return { asset, mesh };
}

function collectRigMaterials(root: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const materials: THREE.MeshStandardMaterial[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }
    const material = object.material;
    if (material instanceof THREE.MeshStandardMaterial) {
      materials.push(material);
    }
  });
  return materials;
}

function requirePart(id: string): ModelPart {
  const part = stackChanModelManifest.parts.find((candidate) => candidate.id === id);
  if (!part) {
    throw new Error(`Stack-chan model manifest is missing part ${id}`);
  }
  return part;
}

function requirePivot(id: string): ModelPivot {
  const pivot = stackChanModelManifest.pivots.find((candidate) => candidate.id === id);
  if (!pivot) {
    throw new Error(`Stack-chan model manifest is missing pivot ${id}`);
  }
  return pivot;
}

function toSceneVector(vector: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(mm(vector.x), mm(vector.y), mm(vector.z));
}

function eyeScaleY(mode: StackChanPreviewModel["leftEyeMode"]): number {
  switch (mode) {
    case "closed":
      return 0.18;
    case "squint":
      return 0.45;
    case "wide":
      return 1.28;
    case "open":
      return 1;
  }
}

function mouthScale(mode: StackChanPreviewModel["mouthMode"]): { x: number; y: number } {
  switch (mode) {
    case "laugh":
    case "open":
      return { x: 1.05, y: 1.15 };
    case "frown":
      return { x: 0.9, y: 0.28 };
    case "sing":
      return { x: 0.55, y: 1.05 };
    case "neutral":
    case "smile":
      return { x: 1, y: 0.26 };
  }
}

function mm(value: number): number {
  return value * MILLIMETERS_TO_SCENE_UNITS;
}
