import { StackChanThreePreview } from "./stackchan-three-preview.js";

type PreviewHardwareStatus =
  | "verified-on-hardware"
  | "partially-verified"
  | "unverified"
  | "simulated-only"
  | "unsafe";

type PreviewEyeMode = "open" | "closed" | "squint" | "wink" | "wide";
type PreviewMouthMode = "neutral" | "smile" | "laugh" | "frown" | "open" | "sing";
type PreviewHardwareTone = "verified" | "warning" | "unsafe";

interface PreviewHardwareVerification {
  status: PreviewHardwareStatus;
  label: string;
  notes?: string;
}

interface PreviewDisplaySpec {
  width: number;
  height: number;
  shape: "round" | "rectangular" | "square";
}

interface PreviewJointSpec {
  id: string;
  name: string;
  axis: "pitch" | "yaw" | "roll" | "linear";
  unit: "degrees" | "millimeters";
  min: number;
  max: number;
  neutral: number;
  hardwareVerification?: PreviewHardwareVerification;
}

export interface StackChanPreviewProfile {
  id: string;
  name: string;
  formFactor: string;
  display: PreviewDisplaySpec;
  joints: PreviewJointSpec[];
  hardwareVerification: PreviewHardwareVerification;
}

export interface StackChanPreviewRenderState {
  behaviorId: string;
  behaviorName: string;
  elapsedMs: number;
  durationMs: number;
  progress: number;
  complete: boolean;
  hardwareVerificationStatus: PreviewHardwareStatus;
  hardwareVerified: boolean;
  compatible: boolean;
  expression?: {
    id: string;
    intensity?: number;
    eyes?: PreviewEyeMode;
    mouth?: PreviewMouthMode;
  };
  viseme?: {
    id: string;
    weight?: number;
  };
  joints: Record<string, { value: number }>;
  display?: {
    mode: "face" | "image" | "text" | "clear";
    text?: string;
    backgroundColor?: string;
  };
  leds: Record<string, {
    color?: string;
    brightness?: number;
    effect?: "solid" | "pulse" | "blink" | "off";
  }>;
  ignoredChannels: Array<{
    channel: string;
    targetId?: string;
    reason: string;
  }>;
  activeFrame?: {
    index: number;
    atMs: number;
    label?: string;
  };
}

export interface PreviewJointReadout {
  id: string;
  label: string;
  axis: PreviewJointSpec["axis"];
  unit: PreviewJointSpec["unit"];
  value: number;
  min: number;
  max: number;
  percent: number;
  verified: boolean;
}

export interface StackChanPreviewModel {
  profileId: string;
  behaviorId: string;
  behaviorName: string;
  formFactor: string;
  displayShape: PreviewDisplaySpec["shape"];
  yawDegrees: number;
  pitchDegrees: number;
  hasMotion: boolean;
  expressionLabel: string;
  visemeLabel: string;
  leftEyeMode: Exclude<PreviewEyeMode, "wink">;
  rightEyeMode: Exclude<PreviewEyeMode, "wink">;
  mouthMode: PreviewMouthMode;
  screenBackground: string;
  ledColor: string;
  ledEffect: string;
  progressPercent: number;
  elapsedLabel: string;
  frameLabel: string;
  hardwareTone: PreviewHardwareTone;
  hardwareLabel: string;
  warnings: string[];
  joints: PreviewJointReadout[];
  nonBlankRegions: number;
  fingerprint: string;
}

const VERIFIED_STATUSES = new Set<PreviewHardwareStatus>([
  "verified-on-hardware",
  "partially-verified",
]);

const YAW_ALIASES = ["head.yaw", "neck_yaw", "neck.yaw", "pan"];
const PITCH_ALIASES = ["head.pitch", "neck_pitch", "neck.pitch", "tilt"];

export class StackChanPreview {
  private readonly root: HTMLElement;
  private readonly threeHost: HTMLElement;
  private readonly threePreview?: StackChanThreePreview;
  private readonly renderError?: HTMLElement;
  private readonly statusBadge: HTMLElement;
  private readonly jointList: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly elapsedValue: HTMLElement;
  private readonly poseValue: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    const document = root.ownerDocument;

    this.threeHost = createElement(document, "div", "stackchan-three-host");
    let threePreview: StackChanThreePreview | undefined;
    let renderError: HTMLElement | undefined;
    try {
      threePreview = new StackChanThreePreview(this.threeHost);
      root.dataset.renderer = "three";
    } catch (error) {
      renderError = createElement(document, "div", "stackchan-render-error");
      renderError.textContent = error instanceof Error
        ? `WebGL required for Stack-chan physical simulation: ${error.message}`
        : "WebGL required for Stack-chan physical simulation";
      this.threeHost.replaceChildren(renderError);
      root.dataset.renderer = "webgl-required";
    }
    this.threePreview = threePreview;
    this.renderError = renderError;

    const telemetry = createElement(document, "div", "preview-telemetry");
    this.statusBadge = createElement(document, "div", "preview-hardware-badge");
    this.poseValue = createElement(document, "div", "preview-pose-value");
    this.elapsedValue = createElement(document, "div", "preview-elapsed-value");
    const progress = createElement(document, "div", "preview-progress");
    this.progressFill = createElement(document, "span", "preview-progress-fill");
    progress.append(this.progressFill);
    telemetry.append(this.statusBadge, this.poseValue, this.elapsedValue, progress);

    this.jointList = createElement(document, "div", "preview-joint-list");

    root.classList.add("stackchan-preview-root");
    root.replaceChildren(this.threeHost, telemetry, this.jointList);
  }

  update(profile: StackChanPreviewProfile, renderState: StackChanPreviewRenderState): StackChanPreviewModel {
    const model = createStackChanPreviewModel(profile, renderState);
    this.render(model);
    return model;
  }

  private render(model: StackChanPreviewModel): void {
    this.root.dataset.formFactor = model.formFactor;
    this.root.dataset.displayShape = model.displayShape;
    this.root.dataset.hardware = model.hardwareTone;
    this.root.dataset.motion = model.hasMotion ? "available" : "none";
    this.root.dataset.warningCount = String(model.warnings.length);
    this.root.dataset.previewFingerprint = model.fingerprint;
    this.root.setAttribute(
      "aria-label",
      `${model.behaviorName}: yaw ${model.yawDegrees}, pitch ${model.pitchDegrees}, ${model.hardwareLabel}`,
    );

    this.threePreview?.update(model);
    if (this.renderError) {
      this.renderError.textContent = `WebGL required for Stack-chan physical simulation. Pose requested: yaw ${formatDegrees(model.yawDegrees)}, pitch ${formatDegrees(model.pitchDegrees)}.`;
    }

    this.statusBadge.textContent = model.hardwareLabel;
    this.poseValue.textContent = `Yaw ${formatDegrees(model.yawDegrees)} / Pitch ${formatDegrees(model.pitchDegrees)}`;
    this.elapsedValue.textContent = `${model.elapsedLabel} / ${model.frameLabel}`;
    this.progressFill.style.width = `${model.progressPercent}%`;

    this.jointList.replaceChildren(
      ...model.joints.map((joint) => {
        const row = createElement(this.root.ownerDocument, "div", "preview-joint-row");
        row.dataset.verified = String(joint.verified);
        const label = createElement(this.root.ownerDocument, "span", "preview-joint-label");
        label.textContent = joint.label;
        const value = createElement(this.root.ownerDocument, "span", "preview-joint-value");
        value.textContent = joint.unit === "degrees" ? formatDegrees(joint.value) : `${round(joint.value)} mm`;
        const meter = createElement(this.root.ownerDocument, "span", "preview-joint-meter");
        const fill = createElement(this.root.ownerDocument, "span", "preview-joint-fill");
        fill.style.width = `${joint.percent}%`;
        meter.append(fill);
        row.append(label, meter, value);
        return row;
      }),
    );
  }
}

export function createStackChanPreviewModel(
  profile: StackChanPreviewProfile,
  renderState: StackChanPreviewRenderState,
): StackChanPreviewModel {
  const yaw = readAxisJoint(profile, renderState, "yaw", YAW_ALIASES);
  const pitch = readAxisJoint(profile, renderState, "pitch", PITCH_ALIASES);
  const expression = renderState.expression;
  const viseme = renderState.viseme;
  const eyeMode = expression?.eyes ?? "open";
  const mouthMode = expression?.mouth ?? mouthFromViseme(viseme?.id);
  const firstLed = Object.values(renderState.leds)[0];
  const profileVerified = isVerified(profile.hardwareVerification.status);
  const behaviorVerified = renderState.hardwareVerified;
  const hardwareTone = chooseHardwareTone(profile.hardwareVerification.status, renderState.hardwareVerificationStatus);
  const warnings = createWarnings(profile, renderState, profileVerified, behaviorVerified);
  const joints = createJointReadouts(profile, renderState);
  const hasMotion = profile.joints.some((joint) => joint.axis === "yaw" || joint.axis === "pitch");
  const progressPercent = round(Math.max(0, Math.min(1, renderState.progress)) * 100);
  const expressionLabel = expression?.id ?? "neutral";
  const visemeLabel = viseme?.id ?? "rest";
  const displayBackground = renderState.display?.backgroundColor;
  const screenBackground = isColorLike(displayBackground) ? displayBackground : "#101918";
  const ledColor = isColorLike(firstLed?.color) ? firstLed.color : "#50d6c6";
  const frameLabel = renderState.activeFrame
    ? `${renderState.activeFrame.label ?? `frame ${renderState.activeFrame.index + 1}`} @ ${renderState.activeFrame.atMs} ms`
    : "no active frame";

  const leftEyeMode = eyeMode === "wink" ? "closed" : eyeMode;
  const rightEyeMode = eyeMode === "wink" ? "open" : eyeMode;
  const hardwareLabel = profileVerified && behaviorVerified
    ? "Verified"
    : hardwareTone === "unsafe"
      ? "Unsafe"
      : "Unverified";
  const nonBlankRegions = 5 + joints.length + (warnings.length > 0 ? 1 : 0);
  const fingerprint = [
    profile.id,
    renderState.behaviorId,
    round(renderState.elapsedMs),
    yaw.value,
    pitch.value,
    expressionLabel,
    visemeLabel,
    hardwareTone,
    warnings.length,
  ].join("|");

  return {
    profileId: profile.id,
    behaviorId: renderState.behaviorId,
    behaviorName: renderState.behaviorName,
    formFactor: profile.formFactor,
    displayShape: profile.display.shape,
    yawDegrees: yaw.value,
    pitchDegrees: pitch.value,
    hasMotion,
    expressionLabel,
    visemeLabel,
    leftEyeMode,
    rightEyeMode,
    mouthMode,
    screenBackground,
    ledColor,
    ledEffect: firstLed?.effect ?? "solid",
    progressPercent,
    elapsedLabel: `${round(renderState.elapsedMs)} ms`,
    frameLabel,
    hardwareTone,
    hardwareLabel,
    warnings,
    joints,
    nonBlankRegions,
    fingerprint,
  };
}

export function formatPreviewMotion(
  profile: StackChanPreviewProfile,
  renderState: StackChanPreviewRenderState,
): string {
  const yaw = readAxisJoint(profile, renderState, "yaw", YAW_ALIASES);
  const pitch = readAxisJoint(profile, renderState, "pitch", PITCH_ALIASES);
  if (!profile.joints.some((joint) => joint.axis === "yaw" || joint.axis === "pitch")) {
    return "Motion unavailable";
  }
  return `Yaw ${formatDegrees(yaw.value)} / Pitch ${formatDegrees(pitch.value)}`;
}

function readAxisJoint(
  profile: StackChanPreviewProfile,
  renderState: StackChanPreviewRenderState,
  axis: "yaw" | "pitch",
  aliases: string[],
): { value: number; min: number; max: number; neutral: number } {
  const spec = profile.joints.find((joint) => joint.axis === axis)
    ?? profile.joints.find((joint) => aliases.includes(joint.id));
  const stateValue = spec ? renderState.joints[spec.id]?.value : undefined;
  const aliasValue = aliases
    .map((alias) => renderState.joints[alias]?.value)
    .find((value) => typeof value === "number" && Number.isFinite(value));
  const min = spec?.min ?? (axis === "yaw" ? -35 : -25);
  const max = spec?.max ?? (axis === "yaw" ? 35 : 25);
  const neutral = spec?.neutral ?? 0;
  const value = stateValue ?? aliasValue ?? neutral;
  return {
    value: round(clamp(value, min, max)),
    min,
    max,
    neutral,
  };
}

function createJointReadouts(
  profile: StackChanPreviewProfile,
  renderState: StackChanPreviewRenderState,
): PreviewJointReadout[] {
  return profile.joints
    .filter((joint) => joint.axis === "yaw" || joint.axis === "pitch")
    .map((joint) => {
      const rawValue = renderState.joints[joint.id]?.value ?? joint.neutral;
      const value = round(clamp(rawValue, joint.min, joint.max));
      return {
        id: joint.id,
        label: joint.name,
        axis: joint.axis,
        unit: joint.unit,
        value,
        min: joint.min,
        max: joint.max,
        percent: round(((value - joint.min) / (joint.max - joint.min)) * 100),
        verified: joint.hardwareVerification ? isVerified(joint.hardwareVerification.status) : false,
      };
    });
}

function createWarnings(
  profile: StackChanPreviewProfile,
  renderState: StackChanPreviewRenderState,
  profileVerified: boolean,
  behaviorVerified: boolean,
): string[] {
  const warnings: string[] = [];
  if (!profileVerified) {
    warnings.push(profile.hardwareVerification.label);
  }
  if (!behaviorVerified) {
    warnings.push(`Behavior ${statusLabel(renderState.hardwareVerificationStatus)}`);
  }
  if (!renderState.compatible) {
    warnings.push("Behavior is not marked compatible with this profile");
  }
  if (profile.joints.length === 0) {
    warnings.push("No yaw/pitch hardware on selected profile");
  }
  const ignoredMotion = renderState.ignoredChannels.find((ignored) => ignored.channel === "joints");
  if (ignoredMotion) {
    warnings.push(`Motion degraded: ${ignoredMotion.reason}`);
  }
  return dedupe(warnings);
}

function chooseHardwareTone(
  profileStatus: PreviewHardwareStatus,
  behaviorStatus: PreviewHardwareStatus,
): PreviewHardwareTone {
  if (profileStatus === "unsafe" || behaviorStatus === "unsafe") {
    return "unsafe";
  }
  if (isVerified(profileStatus) && isVerified(behaviorStatus)) {
    return "verified";
  }
  return "warning";
}

function isVerified(status: PreviewHardwareStatus): boolean {
  return VERIFIED_STATUSES.has(status);
}

function statusLabel(status: PreviewHardwareStatus): string {
  switch (status) {
    case "verified-on-hardware":
      return "verified on hardware";
    case "partially-verified":
      return "partially verified";
    case "simulated-only":
      return "simulation only";
    case "unsafe":
      return "unsafe";
    case "unverified":
      return "unverified";
  }
}

function mouthFromViseme(visemeId: string | undefined): PreviewMouthMode {
  switch (visemeId) {
    case "aa":
    case "a":
    case "oh":
    case "o":
      return "open";
    case "wide":
    case "ee":
    case "e":
      return "sing";
    case "m":
    case "sil":
    case "rest":
    case "closed":
      return "neutral";
    default:
      return "neutral";
  }
}

function isColorLike(value: string | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value);
}

function formatDegrees(value: number): string {
  return `${round(value)}deg`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function createElement(document: Document, tagName: string, className: string): HTMLElement {
  const element = document.createElement(tagName);
  element.className = className;
  return element;
}
