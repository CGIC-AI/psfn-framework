export const BEHAVIOR_CHANNELS = [
  "expression",
  "viseme",
  "joints",
  "display",
  "backlight",
  "leds",
] as const;

export type BehaviorChannel = (typeof BEHAVIOR_CHANNELS)[number];

export type DeviceFormFactor =
  | "stackchan-style"
  | "round-lcd"
  | "rectangular-lcd"
  | "desktop-preview"
  | "custom";

export type DisplayShape = "round" | "rectangular" | "square";

export type DeviceInputCapability = "text" | "audio" | "touch" | "button" | "gesture";

export type DeviceOutputCapability =
  | "display"
  | "expression"
  | "viseme"
  | "speech"
  | "audio"
  | "motion"
  | "led"
  | "backlight";

export type DeviceControlCapability =
  | "interrupt"
  | "behavior-playback"
  | "profile-select"
  | "brightness"
  | "volume";

export type ProvenanceSource =
  | "official"
  | "device-derived"
  | "host-generated"
  | "user-authored"
  | "test-fixture";

export type HardwareVerificationStatus =
  | "verified-on-hardware"
  | "partially-verified"
  | "unverified"
  | "simulated-only"
  | "unsafe";

export interface Provenance {
  label: string;
  source: ProvenanceSource;
  url?: string;
  notes?: string;
}

export interface HardwareVerification {
  status: HardwareVerificationStatus;
  label: string;
  verifiedAt?: string;
  verifiedBy?: string;
  notes?: string;
}

export interface DisplaySpec {
  width: number;
  height: number;
  shape: DisplayShape;
  colorDepth?: number;
  safeArea?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface TouchSpec {
  supported: boolean;
  points?: number;
  gestures?: Array<"tap" | "double-tap" | "long-press" | "swipe" | "drag">;
}

export interface DeviceCapabilities {
  input: DeviceInputCapability[];
  output: DeviceOutputCapability[];
  control: DeviceControlCapability[];
}

export interface JointSpec {
  id: string;
  name: string;
  axis: "pitch" | "yaw" | "roll" | "linear";
  unit: "degrees" | "millimeters";
  min: number;
  max: number;
  neutral: number;
  hardwareVerification?: HardwareVerification;
}

export interface LedSpec {
  id: string;
  name: string;
  kind: "mono" | "rgb" | "rgbw";
  count?: number;
  hardwareVerification?: HardwareVerification;
}

export interface BacklightSpec {
  supported: boolean;
  min: number;
  max: number;
  hardwareVerification?: HardwareVerification;
}

export interface DeviceProfile {
  id: string;
  name: string;
  formFactor: DeviceFormFactor;
  display: DisplaySpec;
  touch: TouchSpec;
  capabilities: DeviceCapabilities;
  joints: JointSpec[];
  leds: LedSpec[];
  backlight: BacklightSpec;
  provenance: Provenance;
  hardwareVerification: HardwareVerification;
}

export interface ExpressionState {
  id: string;
  intensity?: number;
  eyes?: "open" | "closed" | "squint" | "wink" | "wide";
  mouth?: "neutral" | "smile" | "laugh" | "frown" | "open" | "sing";
}

export interface VisemeState {
  id: string;
  weight?: number;
}

export interface JointFrameState {
  value: number;
}

export interface DisplayFrameState {
  mode: "face" | "image" | "text" | "clear";
  assetId?: string;
  text?: string;
  backgroundColor?: string;
}

export interface BacklightFrameState {
  brightness: number;
}

export interface LedFrameState {
  color?: string;
  brightness?: number;
  effect?: "solid" | "pulse" | "blink" | "off";
}

export interface BehaviorFrame {
  atMs: number;
  durationMs?: number;
  label?: string;
  expression?: ExpressionState;
  viseme?: VisemeState;
  joints?: Record<string, JointFrameState>;
  display?: DisplayFrameState;
  backlight?: BacklightFrameState;
  leds?: Record<string, LedFrameState>;
  provenance?: Provenance;
  hardwareVerification?: HardwareVerification;
}

export interface BehaviorTimeline {
  id: string;
  name: string;
  compatibleProfileIds: string[];
  channels: BehaviorChannel[];
  durationMs?: number;
  frames: BehaviorFrame[];
  provenance: Provenance;
  hardwareVerification: HardwareVerification;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface IgnoredBehaviorChannel {
  channel: BehaviorChannel;
  targetId?: string;
  reason: string;
}

export interface BehaviorApplicationResult {
  profileId: string;
  behaviorId: string;
  compatible: boolean;
  supportedChannels: BehaviorChannel[];
  ignoredChannels: IgnoredBehaviorChannel[];
  timeline: BehaviorTimeline;
}

const BEHAVIOR_CHANNEL_SET = new Set<string>(BEHAVIOR_CHANNELS);
const HARDWARE_VERIFIED_STATUSES = new Set<HardwareVerificationStatus>([
  "verified-on-hardware",
  "partially-verified",
]);

export function validateDeviceProfile(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const profile = asRecord(value);
  if (!profile) {
    return [{ path: "$", message: "Device profile must be an object" }];
  }

  requireNonEmptyString(profile.id, "id", issues);
  requireNonEmptyString(profile.name, "name", issues);
  requireNonEmptyString(profile.formFactor, "formFactor", issues);
  validateDisplay(profile.display, "display", issues);
  validateTouch(profile.touch, "touch", issues);
  validateCapabilities(profile.capabilities, "capabilities", issues);
  validateJointSpecs(profile.joints, "joints", issues);
  validateLedSpecs(profile.leds, "leds", issues);
  validateBacklight(profile.backlight, "backlight", issues);
  validateProvenance(profile.provenance, "provenance", issues);
  validateHardwareVerification(profile.hardwareVerification, "hardwareVerification", issues);

  const capabilities = asRecord(profile.capabilities);
  const output = Array.isArray(capabilities?.output) ? capabilities.output : [];
  if (Array.isArray(profile.joints) && profile.joints.length > 0 && !output.includes("motion")) {
    issues.push({
      path: "capabilities.output",
      message: "Profiles with joints should advertise the motion output capability",
    });
  }
  if (Array.isArray(profile.leds) && profile.leds.length > 0 && !output.includes("led")) {
    issues.push({
      path: "capabilities.output",
      message: "Profiles with LEDs should advertise the led output capability",
    });
  }

  return issues;
}

export function validateBehaviorTimeline(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const timeline = asRecord(value);
  if (!timeline) {
    return [{ path: "$", message: "Behavior timeline must be an object" }];
  }

  requireNonEmptyString(timeline.id, "id", issues);
  requireNonEmptyString(timeline.name, "name", issues);
  validateStringArray(timeline.compatibleProfileIds, "compatibleProfileIds", issues);
  validateBehaviorChannelArray(timeline.channels, "channels", issues);
  validateProvenance(timeline.provenance, "provenance", issues);
  validateHardwareVerification(timeline.hardwareVerification, "hardwareVerification", issues);

  if (timeline.durationMs !== undefined) {
    requireNonNegativeNumber(timeline.durationMs, "durationMs", issues);
  }

  if (!Array.isArray(timeline.frames)) {
    issues.push({ path: "frames", message: "frames is required and must be an array" });
    return issues;
  }
  if (timeline.frames.length === 0) {
    issues.push({ path: "frames", message: "frames must contain at least one frame" });
  }

  const declaredChannels = new Set(
    Array.isArray(timeline.channels) ? timeline.channels.filter((channel) => typeof channel === "string") : [],
  );
  const observedChannels = new Set<BehaviorChannel>();
  let previousAtMs = -Infinity;
  let latestEndMs = 0;

  for (const [index, frameValue] of timeline.frames.entries()) {
    const path = `frames[${index}]`;
    const frame = asRecord(frameValue);
    if (!frame) {
      issues.push({ path, message: "frame must be an object" });
      continue;
    }
    const atMs = readNonNegativeNumber(frame.atMs, `${path}.atMs`, issues);
    const durationMs = frame.durationMs === undefined
      ? 0
      : readNonNegativeNumber(frame.durationMs, `${path}.durationMs`, issues);
    if (atMs !== undefined) {
      if (atMs < previousAtMs) {
        issues.push({ path: `${path}.atMs`, message: "frames must be ordered by atMs" });
      }
      previousAtMs = atMs;
      latestEndMs = Math.max(latestEndMs, atMs + (durationMs ?? 0));
    }
    collectFrameChannels(frame, observedChannels);
    validateFrameState(frame, path, issues);
  }

  for (const channel of observedChannels) {
    if (!declaredChannels.has(channel)) {
      issues.push({
        path: "channels",
        message: `channels must include observed frame channel ${channel}`,
      });
    }
  }

  if (typeof timeline.durationMs === "number" && timeline.durationMs < latestEndMs) {
    issues.push({
      path: "durationMs",
      message: "durationMs must be greater than or equal to the final frame end time",
    });
  }

  return issues;
}

export function assertValidDeviceProfile(value: unknown): asserts value is DeviceProfile {
  const issues = validateDeviceProfile(value);
  if (issues.length > 0) {
    throw new Error(formatValidationIssues("Invalid device profile", issues));
  }
}

export function assertValidBehaviorTimeline(value: unknown): asserts value is BehaviorTimeline {
  const issues = validateBehaviorTimeline(value);
  if (issues.length > 0) {
    throw new Error(formatValidationIssues("Invalid behavior timeline", issues));
  }
}

export function calculateBehaviorDuration(timeline: BehaviorTimeline): number {
  let latestEndMs = 0;
  for (const frame of timeline.frames) {
    latestEndMs = Math.max(latestEndMs, frame.atMs + (frame.durationMs ?? 0));
  }
  return Math.max(timeline.durationMs ?? 0, latestEndMs);
}

export function inferBehaviorChannels(timeline: BehaviorTimeline): BehaviorChannel[] {
  const channels = new Set<BehaviorChannel>();
  for (const frame of timeline.frames) {
    collectFrameChannels(frame as unknown as Record<string, unknown>, channels);
  }
  return BEHAVIOR_CHANNELS.filter((channel) => channels.has(channel));
}

export function getSupportedBehaviorChannels(profile: DeviceProfile): BehaviorChannel[] {
  const output = new Set(profile.capabilities.output);
  const supported = new Set<BehaviorChannel>();
  if (output.has("expression")) supported.add("expression");
  if (output.has("viseme")) supported.add("viseme");
  if (output.has("display")) supported.add("display");
  if (profile.joints.length > 0) supported.add("joints");
  if (profile.backlight.supported) supported.add("backlight");
  if (profile.leds.length > 0) supported.add("leds");
  return BEHAVIOR_CHANNELS.filter((channel) => supported.has(channel));
}

export function isBehaviorCompatibleWithProfile(profile: DeviceProfile, timeline: BehaviorTimeline): boolean {
  return timeline.compatibleProfileIds.length === 0 || timeline.compatibleProfileIds.includes(profile.id);
}

export function applyBehaviorToProfile(
  profile: DeviceProfile,
  timeline: BehaviorTimeline,
): BehaviorApplicationResult {
  const supportedChannels = getSupportedBehaviorChannels(profile);
  const supportedChannelSet = new Set(supportedChannels);
  const supportedJointIds = new Set(profile.joints.map((joint) => joint.id));
  const supportedLedIds = new Set(profile.leds.map((led) => led.id));
  const ignored = new Map<string, IgnoredBehaviorChannel>();

  const frames = timeline.frames.map((frame) => {
    const next: BehaviorFrame = { ...frame };

    if (next.expression && !supportedChannelSet.has("expression")) {
      rememberIgnored(ignored, { channel: "expression", reason: "profile does not support expression output" });
      delete next.expression;
    }
    if (next.viseme && !supportedChannelSet.has("viseme")) {
      rememberIgnored(ignored, { channel: "viseme", reason: "profile does not support viseme output" });
      delete next.viseme;
    }
    if (next.display && !supportedChannelSet.has("display")) {
      rememberIgnored(ignored, { channel: "display", reason: "profile does not support display output" });
      delete next.display;
    }
    if (next.backlight && !supportedChannelSet.has("backlight")) {
      rememberIgnored(ignored, { channel: "backlight", reason: "profile does not support backlight output" });
      delete next.backlight;
    }
    if (next.joints) {
      if (!supportedChannelSet.has("joints")) {
        rememberIgnored(ignored, { channel: "joints", reason: "profile does not support joint output" });
        delete next.joints;
      } else {
        const filteredJoints = filterRecord(next.joints, (jointId) => {
          const supported = supportedJointIds.has(jointId);
          if (!supported) {
            rememberIgnored(ignored, {
              channel: "joints",
              targetId: jointId,
              reason: "profile does not define this joint",
            });
          }
          return supported;
        });
        next.joints = Object.keys(filteredJoints).length > 0 ? filteredJoints : undefined;
      }
    }
    if (next.leds) {
      if (!supportedChannelSet.has("leds")) {
        rememberIgnored(ignored, { channel: "leds", reason: "profile does not support LED output" });
        delete next.leds;
      } else {
        const filteredLeds = filterRecord(next.leds, (ledId) => {
          const supported = supportedLedIds.has(ledId);
          if (!supported) {
            rememberIgnored(ignored, {
              channel: "leds",
              targetId: ledId,
              reason: "profile does not define this LED",
            });
          }
          return supported;
        });
        next.leds = Object.keys(filteredLeds).length > 0 ? filteredLeds : undefined;
      }
    }

    return next;
  });

  const degradedTimeline: BehaviorTimeline = {
    ...timeline,
    channels: inferBehaviorChannels({ ...timeline, frames }),
    frames,
  };

  return {
    profileId: profile.id,
    behaviorId: timeline.id,
    compatible: isBehaviorCompatibleWithProfile(profile, timeline),
    supportedChannels,
    ignoredChannels: [...ignored.values()],
    timeline: degradedTimeline,
  };
}

export function isGeneratedProvenance(provenance: Provenance): boolean {
  return provenance.source === "host-generated"
    || provenance.source === "user-authored"
    || provenance.source === "test-fixture";
}

export function isHardwareVerified(verification: HardwareVerification): boolean {
  return HARDWARE_VERIFIED_STATUSES.has(verification.status);
}

function validateDisplay(value: unknown, path: string, issues: ValidationIssue[]): void {
  const display = asRecord(value);
  if (!display) {
    issues.push({ path, message: "display is required and must be an object" });
    return;
  }
  requirePositiveNumber(display.width, `${path}.width`, issues);
  requirePositiveNumber(display.height, `${path}.height`, issues);
  requireNonEmptyString(display.shape, `${path}.shape`, issues);
  if (display.colorDepth !== undefined) {
    requirePositiveNumber(display.colorDepth, `${path}.colorDepth`, issues);
  }
}

function validateTouch(value: unknown, path: string, issues: ValidationIssue[]): void {
  const touch = asRecord(value);
  if (!touch) {
    issues.push({ path, message: "touch is required and must be an object" });
    return;
  }
  if (typeof touch.supported !== "boolean") {
    issues.push({ path: `${path}.supported`, message: "supported is required and must be a boolean" });
  }
  if (touch.points !== undefined) {
    requirePositiveNumber(touch.points, `${path}.points`, issues);
  }
}

function validateCapabilities(value: unknown, path: string, issues: ValidationIssue[]): void {
  const capabilities = asRecord(value);
  if (!capabilities) {
    issues.push({ path, message: "capabilities is required and must be an object" });
    return;
  }
  validateStringArray(capabilities.input, `${path}.input`, issues, true);
  validateStringArray(capabilities.output, `${path}.output`, issues, true);
  validateStringArray(capabilities.control, `${path}.control`, issues);
}

function validateJointSpecs(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "joints is required and must be an array" });
    return;
  }
  for (const [index, item] of value.entries()) {
    const joint = asRecord(item);
    const itemPath = `${path}[${index}]`;
    if (!joint) {
      issues.push({ path: itemPath, message: "joint must be an object" });
      continue;
    }
    requireNonEmptyString(joint.id, `${itemPath}.id`, issues);
    requireNonEmptyString(joint.name, `${itemPath}.name`, issues);
    requireNonEmptyString(joint.axis, `${itemPath}.axis`, issues);
    requireNonEmptyString(joint.unit, `${itemPath}.unit`, issues);
    const min = readNumber(joint.min, `${itemPath}.min`, issues);
    const max = readNumber(joint.max, `${itemPath}.max`, issues);
    const neutral = readNumber(joint.neutral, `${itemPath}.neutral`, issues);
    if (min !== undefined && max !== undefined && min >= max) {
      issues.push({ path: `${itemPath}.max`, message: "max must be greater than min" });
    }
    if (min !== undefined && max !== undefined && neutral !== undefined && (neutral < min || neutral > max)) {
      issues.push({ path: `${itemPath}.neutral`, message: "neutral must be within min and max" });
    }
    if (joint.hardwareVerification !== undefined) {
      validateHardwareVerification(joint.hardwareVerification, `${itemPath}.hardwareVerification`, issues);
    }
  }
}

function validateLedSpecs(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "leds is required and must be an array" });
    return;
  }
  for (const [index, item] of value.entries()) {
    const led = asRecord(item);
    const itemPath = `${path}[${index}]`;
    if (!led) {
      issues.push({ path: itemPath, message: "LED must be an object" });
      continue;
    }
    requireNonEmptyString(led.id, `${itemPath}.id`, issues);
    requireNonEmptyString(led.name, `${itemPath}.name`, issues);
    requireNonEmptyString(led.kind, `${itemPath}.kind`, issues);
    if (led.count !== undefined) {
      requirePositiveNumber(led.count, `${itemPath}.count`, issues);
    }
    if (led.hardwareVerification !== undefined) {
      validateHardwareVerification(led.hardwareVerification, `${itemPath}.hardwareVerification`, issues);
    }
  }
}

function validateBacklight(value: unknown, path: string, issues: ValidationIssue[]): void {
  const backlight = asRecord(value);
  if (!backlight) {
    issues.push({ path, message: "backlight is required and must be an object" });
    return;
  }
  if (typeof backlight.supported !== "boolean") {
    issues.push({ path: `${path}.supported`, message: "supported is required and must be a boolean" });
  }
  const min = readNumber(backlight.min, `${path}.min`, issues);
  const max = readNumber(backlight.max, `${path}.max`, issues);
  if (min !== undefined && max !== undefined && min >= max) {
    issues.push({ path: `${path}.max`, message: "max must be greater than min" });
  }
  if (backlight.hardwareVerification !== undefined) {
    validateHardwareVerification(backlight.hardwareVerification, `${path}.hardwareVerification`, issues);
  }
}

function validateProvenance(value: unknown, path: string, issues: ValidationIssue[]): void {
  const provenance = asRecord(value);
  if (!provenance) {
    issues.push({ path, message: "provenance is required and must be an object" });
    return;
  }
  requireNonEmptyString(provenance.label, `${path}.label`, issues);
  requireNonEmptyString(provenance.source, `${path}.source`, issues);
}

function validateHardwareVerification(value: unknown, path: string, issues: ValidationIssue[]): void {
  const verification = asRecord(value);
  if (!verification) {
    issues.push({ path, message: "hardwareVerification is required and must be an object" });
    return;
  }
  requireNonEmptyString(verification.status, `${path}.status`, issues);
  requireNonEmptyString(verification.label, `${path}.label`, issues);
}

function validateBehaviorChannelArray(value: unknown, path: string, issues: ValidationIssue[]): void {
  validateStringArray(value, path, issues, true);
  if (!Array.isArray(value)) return;
  for (const [index, item] of value.entries()) {
    if (typeof item === "string" && !BEHAVIOR_CHANNEL_SET.has(item)) {
      issues.push({ path: `${path}[${index}]`, message: `unknown behavior channel ${item}` });
    }
  }
}

function validateFrameState(frame: Record<string, unknown>, path: string, issues: ValidationIssue[]): void {
  const expression = asRecord(frame.expression);
  if (expression) {
    requireNonEmptyString(expression.id, `${path}.expression.id`, issues);
    if (expression.intensity !== undefined) {
      requireUnitNumber(expression.intensity, `${path}.expression.intensity`, issues);
    }
  }
  const viseme = asRecord(frame.viseme);
  if (viseme) {
    requireNonEmptyString(viseme.id, `${path}.viseme.id`, issues);
    if (viseme.weight !== undefined) {
      requireUnitNumber(viseme.weight, `${path}.viseme.weight`, issues);
    }
  }
  validateRecordOfObjects(frame.joints, `${path}.joints`, issues, (joint, jointPath) => {
    readNumber(joint.value, `${jointPath}.value`, issues);
  });
  const display = asRecord(frame.display);
  if (display) {
    requireNonEmptyString(display.mode, `${path}.display.mode`, issues);
  }
  const backlight = asRecord(frame.backlight);
  if (backlight) {
    requireUnitNumber(backlight.brightness, `${path}.backlight.brightness`, issues);
  }
  validateRecordOfObjects(frame.leds, `${path}.leds`, issues, (led, ledPath) => {
    if (led.brightness !== undefined) {
      requireUnitNumber(led.brightness, `${ledPath}.brightness`, issues);
    }
  });
}

function collectFrameChannels(frame: Record<string, unknown>, channels: Set<BehaviorChannel>): void {
  if (frame.expression !== undefined) channels.add("expression");
  if (frame.viseme !== undefined) channels.add("viseme");
  if (frame.joints !== undefined) channels.add("joints");
  if (frame.display !== undefined) channels.add("display");
  if (frame.backlight !== undefined) channels.add("backlight");
  if (frame.leds !== undefined) channels.add("leds");
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  requireNonEmpty = false,
): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: `${path} is required and must be an array` });
    return;
  }
  if (requireNonEmpty && value.length === 0) {
    issues.push({ path, message: `${path} must contain at least one value` });
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      issues.push({ path: `${path}[${index}]`, message: "value must be a non-empty string" });
    }
  }
}

function validateRecordOfObjects(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  validate: (record: Record<string, unknown>, path: string) => void,
): void {
  if (value === undefined) return;
  const record = asRecord(value);
  if (!record) {
    issues.push({ path, message: "value must be an object" });
    return;
  }
  for (const [key, item] of Object.entries(record)) {
    const nested = asRecord(item);
    const itemPath = `${path}.${key}`;
    if (!nested) {
      issues.push({ path: itemPath, message: "value must be an object" });
      continue;
    }
    validate(nested, itemPath);
  }
}

function requireNonEmptyString(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: `${path} is required and must be a non-empty string` });
  }
}

function requirePositiveNumber(value: unknown, path: string, issues: ValidationIssue[]): void {
  const numberValue = readNumber(value, path, issues);
  if (numberValue !== undefined && numberValue <= 0) {
    issues.push({ path, message: `${path} must be greater than zero` });
  }
}

function requireNonNegativeNumber(value: unknown, path: string, issues: ValidationIssue[]): void {
  const numberValue = readNumber(value, path, issues);
  if (numberValue !== undefined && numberValue < 0) {
    issues.push({ path, message: `${path} must be greater than or equal to zero` });
  }
}

function readNonNegativeNumber(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  const numberValue = readNumber(value, path, issues);
  if (numberValue !== undefined && numberValue < 0) {
    issues.push({ path, message: `${path} must be greater than or equal to zero` });
    return undefined;
  }
  return numberValue;
}

function requireUnitNumber(value: unknown, path: string, issues: ValidationIssue[]): void {
  const numberValue = readNumber(value, path, issues);
  if (numberValue !== undefined && (numberValue < 0 || numberValue > 1)) {
    issues.push({ path, message: `${path} must be between 0 and 1` });
  }
}

function readNumber(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: `${path} is required and must be a finite number` });
    return undefined;
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function filterRecord<T>(record: Record<string, T>, keep: (key: string) => boolean): Record<string, T> {
  const filtered: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keep(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function rememberIgnored(
  ignored: Map<string, IgnoredBehaviorChannel>,
  ignoredChannel: IgnoredBehaviorChannel,
): void {
  const key = `${ignoredChannel.channel}:${ignoredChannel.targetId ?? "*"}`;
  if (!ignored.has(key)) {
    ignored.set(key, ignoredChannel);
  }
}

function formatValidationIssues(prefix: string, issues: ValidationIssue[]): string {
  return `${prefix}: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`;
}
