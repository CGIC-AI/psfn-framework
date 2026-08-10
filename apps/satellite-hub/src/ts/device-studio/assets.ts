import type { HardwareVerification, Provenance, ValidationIssue } from "./model.js";
import { stackChanProfile } from "./profiles.js";

export type ModelAssetFormat = "stl" | "glb" | "gltf" | "obj";
export type ModelAssetPresence = "expected" | "available" | "generated";
export type ModelCoordinateHandedness = "right-handed" | "left-handed";
export type ModelAxis = "x" | "y" | "z" | "-x" | "-y" | "-z";
export type ModelUnit = "millimeters" | "centimeters" | "meters";
export type ModelPartRole = "body" | "head" | "display" | "neck" | "leds" | "fastener" | "decorative";
export type FallbackPrimitiveKind = "box" | "cylinder" | "sphere" | "rounded-box";

export interface ModelAssetPath {
  format: ModelAssetFormat;
  path: string;
  role: "source" | "normalized" | "preview";
  presence: ModelAssetPresence;
  notes?: string;
}

export interface ModelCoordinateSystem {
  unit: ModelUnit;
  handedness: ModelCoordinateHandedness;
  upAxis: ModelAxis;
  forwardAxis: ModelAxis;
  origin: string;
}

export interface ModelBounds {
  width: number;
  height: number;
  depth: number;
}

export interface ModelVector3 {
  x: number;
  y: number;
  z: number;
}

export interface ModelPivot {
  id: string;
  label: string;
  jointId?: string;
  parentPartId: string;
  childPartIds: string[];
  origin: ModelVector3;
  axis: ModelVector3;
  neutralDegrees: number;
  hardwareVerification: HardwareVerification;
}

export interface FallbackPrimitive {
  kind: FallbackPrimitiveKind;
  bounds: ModelBounds;
  origin: ModelVector3;
  color: string;
}

export interface ModelPart {
  id: string;
  label: string;
  role: ModelPartRole;
  sourcePath?: string;
  pivotId?: string;
  materialHint?: string;
  fallback: FallbackPrimitive;
}

export interface StackChanModelManifest {
  schemaVersion: 1;
  id: string;
  profileId: string;
  label: string;
  assetRoot: string;
  outputRoot: string;
  source: {
    expectedVendorAsset: string;
    license: string;
    status: "source-missing" | "source-present" | "normalized";
    notes: string;
  };
  paths: ModelAssetPath[];
  coordinateSystem: ModelCoordinateSystem;
  approximateBounds: ModelBounds;
  parts: ModelPart[];
  pivots: ModelPivot[];
  provenance: Provenance;
  hardwareVerification: HardwareVerification;
}

const STACKCHAN_ASSET_ROOT = "assets/device-studio/stackchan";
const STACKCHAN_OUTPUT_ROOT = "dist/device-studio/assets/stackchan";

const UNVERIFIED_MODEL_INTAKE: HardwareVerification = {
  status: "unverified",
  label: "Stack-chan model intake not verified on hardware",
  notes: "Pivot positions and fallback bounds are host-side simulator metadata until checked against a physical case.",
};

const HOST_GENERATED_MODEL_PROVENANCE: Provenance = {
  label: "Host-generated Stack-chan model intake manifest",
  source: "host-generated",
  url: "https://github.com/stack-chan/stack-chan/tree/10991598b93f573c0fee88c6be0f004f2e3a8ddb/case/v1",
  notes: [
    "Stack-chan case v1 STL source assets are recorded from the upstream Apache-2.0 stack-chan/stack-chan repository.",
    "This manifest defines the servo pivot hierarchy used by Device Studio preview work.",
  ].join(" "),
};

export const stackChanModelManifest: StackChanModelManifest = {
  schemaVersion: 1,
  id: "stackchan.m5stack.cores3.reference.model",
  profileId: stackChanProfile.id,
  label: "M5Stack Stack-chan Device Studio model intake",
  assetRoot: STACKCHAN_ASSET_ROOT,
  outputRoot: STACKCHAN_OUTPUT_ROOT,
  source: {
    expectedVendorAsset: `${STACKCHAN_ASSET_ROOT}/source/shell.stl`,
    license: "Apache-2.0",
    status: "source-present",
    notes: "Stack-chan case v1 STL source assets are recorded under source/ with upstream commit and license provenance.",
  },
  paths: [
    {
      format: "stl",
      path: `${STACKCHAN_ASSET_ROOT}/source/shell.stl`,
      role: "source",
      presence: "available",
      notes: "Stack-chan case v1 shell STL from upstream stack-chan/stack-chan.",
    },
    {
      format: "stl",
      path: `${STACKCHAN_ASSET_ROOT}/source/feet_top.stl`,
      role: "source",
      presence: "available",
      notes: "Stack-chan case v1 feet top STL from upstream stack-chan/stack-chan.",
    },
    {
      format: "stl",
      path: `${STACKCHAN_ASSET_ROOT}/source/feet_bottom.stl`,
      role: "source",
      presence: "available",
      notes: "Stack-chan case v1 feet bottom STL from upstream stack-chan/stack-chan.",
    },
    {
      format: "stl",
      path: `${STACKCHAN_ASSET_ROOT}/source/bracket_XL330_f.stl`,
      role: "source",
      presence: "available",
      notes: "Stack-chan case v1 front XL330 bracket STL from upstream stack-chan/stack-chan.",
    },
    {
      format: "stl",
      path: `${STACKCHAN_ASSET_ROOT}/source/bracket_XL330_b.stl`,
      role: "source",
      presence: "available",
      notes: "Stack-chan case v1 rear XL330 bracket STL from upstream stack-chan/stack-chan.",
    },
    {
      format: "stl",
      path: `${STACKCHAN_ASSET_ROOT}/source/horn.stl`,
      role: "source",
      presence: "available",
      notes: "Stack-chan case v1 horn STL from upstream stack-chan/stack-chan.",
    },
    {
      format: "glb",
      path: `${STACKCHAN_OUTPUT_ROOT}/stackchan-preview.glb`,
      role: "normalized",
      presence: "generated",
      notes: "Generated browser preview asset after source STL conversion.",
    },
    {
      format: "gltf",
      path: `${STACKCHAN_OUTPUT_ROOT}/stackchan-preview.manifest.json`,
      role: "preview",
      presence: "generated",
      notes: "Generated manifest consumed by the future Three.js renderer.",
    },
  ],
  coordinateSystem: {
    unit: "millimeters",
    handedness: "right-handed",
    upAxis: "y",
    forwardAxis: "z",
    origin: "center of the body footprint on the table plane",
  },
  approximateBounds: {
    width: 86,
    height: 118,
    depth: 72,
  },
  parts: [
    {
      id: "body.shell",
      label: "Body shell",
      role: "body",
      materialHint: "matte-white-plastic",
      fallback: {
        kind: "rounded-box",
        bounds: { width: 76, height: 64, depth: 62 },
        origin: { x: 0, y: 32, z: 0 },
        color: "#f4f1ea",
      },
    },
    {
      id: "head.shell",
      label: "Head shell",
      role: "head",
      pivotId: "pivot.head.yaw",
      materialHint: "matte-white-plastic",
      fallback: {
        kind: "rounded-box",
        bounds: { width: 70, height: 54, depth: 50 },
        origin: { x: 0, y: 86, z: 0 },
        color: "#fbfaf5",
      },
    },
    {
      id: "display.face",
      label: "Face display",
      role: "display",
      pivotId: "pivot.head.pitch",
      materialHint: "black-glass",
      fallback: {
        kind: "box",
        bounds: { width: 52, height: 38, depth: 3 },
        origin: { x: 0, y: 87, z: 26 },
        color: "#111820",
      },
    },
    {
      id: "neck.pan-tilt",
      label: "Pan/tilt neck assembly",
      role: "neck",
      materialHint: "servo-horn",
      fallback: {
        kind: "cylinder",
        bounds: { width: 24, height: 18, depth: 24 },
        origin: { x: 0, y: 66, z: 0 },
        color: "#c9c5bc",
      },
    },
    {
      id: "status.rgb",
      label: "Body RGB LED row",
      role: "leds",
      fallback: {
        kind: "box",
        bounds: { width: 50, height: 4, depth: 2 },
        origin: { x: 0, y: 42, z: 32 },
        color: "#44ff88",
      },
    },
  ],
  pivots: [
    {
      id: "pivot.head.yaw",
      label: "Head yaw pivot",
      jointId: "head.yaw",
      parentPartId: "body.shell",
      childPartIds: ["neck.pan-tilt", "head.shell", "display.face"],
      origin: { x: 0, y: 66, z: 0 },
      axis: { x: 0, y: 1, z: 0 },
      neutralDegrees: 0,
      hardwareVerification: UNVERIFIED_MODEL_INTAKE,
    },
    {
      id: "pivot.head.pitch",
      label: "Head pitch pivot",
      jointId: "head.pitch",
      parentPartId: "neck.pan-tilt",
      childPartIds: ["head.shell", "display.face"],
      origin: { x: 0, y: 82, z: 0 },
      axis: { x: 1, y: 0, z: 0 },
      neutralDegrees: 0,
      hardwareVerification: UNVERIFIED_MODEL_INTAKE,
    },
  ],
  provenance: HOST_GENERATED_MODEL_PROVENANCE,
  hardwareVerification: UNVERIFIED_MODEL_INTAKE,
};

export function validateStackChanModelManifest(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const manifest = asRecord(value);

  if (!manifest) {
    return [{ path: "$", message: "Stack-chan model manifest must be an object" }];
  }

  requireEqual(manifest.schemaVersion, 1, "schemaVersion", issues);
  requireString(manifest.id, "id", issues);
  requireEqual(manifest.profileId, stackChanProfile.id, "profileId", issues);
  requireString(manifest.assetRoot, "assetRoot", issues);
  requireString(manifest.outputRoot, "outputRoot", issues);
  validateCoordinateSystem(manifest.coordinateSystem, "coordinateSystem", issues);
  validateBounds(manifest.approximateBounds, "approximateBounds", issues);
  validatePaths(manifest.paths, "paths", issues);
  validateParts(manifest.parts, "parts", issues);
  validatePivots(manifest.pivots, manifest.parts, "pivots", issues);

  return issues;
}

function validateCoordinateSystem(value: unknown, path: string, issues: ValidationIssue[]): void {
  const coordinateSystem = asRecord(value);
  if (!coordinateSystem) {
    issues.push({ path, message: "Coordinate system must be an object" });
    return;
  }

  requireEqual(coordinateSystem.unit, "millimeters", `${path}.unit`, issues);
  requireEqual(coordinateSystem.handedness, "right-handed", `${path}.handedness`, issues);
  requireString(coordinateSystem.upAxis, `${path}.upAxis`, issues);
  requireString(coordinateSystem.forwardAxis, `${path}.forwardAxis`, issues);
}

function validatePaths(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: "Model manifest must include asset paths" });
    return;
  }

  if (!value.some((item) => asRecord(item)?.role === "source")) {
    issues.push({ path, message: "Model manifest must include a source asset path" });
  }
  if (!value.some((item) => asRecord(item)?.role === "normalized")) {
    issues.push({ path, message: "Model manifest must include a normalized output path" });
  }

  value.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) {
      issues.push({ path: `${path}[${index}]`, message: "Asset path entry must be an object" });
      return;
    }
    requireString(record.format, `${path}[${index}].format`, issues);
    requireString(record.path, `${path}[${index}].path`, issues);
    requireString(record.role, `${path}[${index}].role`, issues);
    requireString(record.presence, `${path}[${index}].presence`, issues);
  });
}

function validateParts(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: "Model manifest must include parts" });
    return;
  }

  const ids = new Set<string>();
  value.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) {
      issues.push({ path: `${path}[${index}]`, message: "Model part must be an object" });
      return;
    }

    if (typeof record.id === "string" && record.id.length > 0) {
      if (ids.has(record.id)) {
        issues.push({ path: `${path}[${index}].id`, message: `Duplicate model part id: ${record.id}` });
      }
      ids.add(record.id);
    } else {
      issues.push({ path: `${path}[${index}].id`, message: "Model part id is required" });
    }

    requireString(record.label, `${path}[${index}].label`, issues);
    requireString(record.role, `${path}[${index}].role`, issues);
    validateFallback(record.fallback, `${path}[${index}].fallback`, issues);
  });

  for (const role of ["body", "head", "display", "neck"] as const) {
    if (!value.some((item) => asRecord(item)?.role === role)) {
      issues.push({ path, message: `Model manifest must include a ${role} part` });
    }
  }
}

function validatePivots(value: unknown, partsValue: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: "Model manifest must include pivots" });
    return;
  }

  const partIds = new Set(
    Array.isArray(partsValue)
      ? partsValue.map((item) => asRecord(item)?.id).filter((id): id is string => typeof id === "string")
      : [],
  );
  const jointIds = new Set(stackChanProfile.joints.map((joint) => joint.id));

  value.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) {
      issues.push({ path: `${path}[${index}]`, message: "Model pivot must be an object" });
      return;
    }

    requireString(record.id, `${path}[${index}].id`, issues);
    if (typeof record.jointId === "string" && !jointIds.has(record.jointId)) {
      issues.push({ path: `${path}[${index}].jointId`, message: `Pivot references unknown joint: ${record.jointId}` });
    }
    if (typeof record.parentPartId === "string" && !partIds.has(record.parentPartId)) {
      issues.push({
        path: `${path}[${index}].parentPartId`,
        message: `Pivot references unknown parent part: ${record.parentPartId}`,
      });
    }
    if (!Array.isArray(record.childPartIds) || record.childPartIds.length === 0) {
      issues.push({ path: `${path}[${index}].childPartIds`, message: "Pivot must include child parts" });
    } else {
      record.childPartIds.forEach((childId, childIndex) => {
        if (typeof childId !== "string" || !partIds.has(childId)) {
          issues.push({
            path: `${path}[${index}].childPartIds[${childIndex}]`,
            message: `Pivot references unknown child part: ${String(childId)}`,
          });
        }
      });
    }
    validateVector(record.origin, `${path}[${index}].origin`, issues);
    validateVector(record.axis, `${path}[${index}].axis`, issues);
  });
}

function validateFallback(value: unknown, path: string, issues: ValidationIssue[]): void {
  const fallback = asRecord(value);
  if (!fallback) {
    issues.push({ path, message: "Fallback primitive is required" });
    return;
  }
  requireString(fallback.kind, `${path}.kind`, issues);
  validateBounds(fallback.bounds, `${path}.bounds`, issues);
  validateVector(fallback.origin, `${path}.origin`, issues);
  requireString(fallback.color, `${path}.color`, issues);
}

function validateBounds(value: unknown, path: string, issues: ValidationIssue[]): void {
  const bounds = asRecord(value);
  if (!bounds) {
    issues.push({ path, message: "Bounds must be an object" });
    return;
  }
  requirePositiveNumber(bounds.width, `${path}.width`, issues);
  requirePositiveNumber(bounds.height, `${path}.height`, issues);
  requirePositiveNumber(bounds.depth, `${path}.depth`, issues);
}

function validateVector(value: unknown, path: string, issues: ValidationIssue[]): void {
  const vector = asRecord(value);
  if (!vector) {
    issues.push({ path, message: "Vector must be an object" });
    return;
  }
  requireFiniteNumber(vector.x, `${path}.x`, issues);
  requireFiniteNumber(vector.y, `${path}.y`, issues);
  requireFiniteNumber(vector.z, `${path}.z`, issues);
}

function requireString(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: "Expected a non-empty string" });
  }
}

function requireEqual(value: unknown, expected: unknown, path: string, issues: ValidationIssue[]): void {
  if (value !== expected) {
    issues.push({ path, message: `Expected ${String(expected)}` });
  }
}

function requirePositiveNumber(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push({ path, message: "Expected a positive finite number" });
  }
}

function requireFiniteNumber(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "Expected a finite number" });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
