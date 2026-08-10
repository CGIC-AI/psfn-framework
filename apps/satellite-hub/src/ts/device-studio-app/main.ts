import {
  BehaviorLibrary,
  createBehaviorPlayback,
  createFixtureBehaviorLibrary,
  exportBehaviorTimeline,
  importBehaviorLibraryJson,
  sampleBehaviorRenderState,
  type BehaviorEvent,
  type BehaviorLibraryEntry,
  type BehaviorPlayback,
  type NormalizedBehaviorRenderState,
} from "../device-studio/behavior.js";
import type {
  BehaviorChannel,
  BehaviorFrame,
  BehaviorTimeline,
  DisplayFrameState,
  ExpressionState,
  HardwareVerification,
  LedFrameState,
  VisemeState,
} from "../device-studio/model.js";
import {
  concreteDeviceProfiles,
  getConcreteDeviceProfile,
  type ConcreteDeviceProfile,
} from "../device-studio/profiles.js";
import {
  DeviceStudioHubClient,
  type DeviceStudioConnectionState,
  type DeviceStudioTransportMode,
  type DeviceStudioTransportSnapshot,
  type DeviceStudioTransportUnsubscribe,
} from "../device-studio/transport.js";
import {
  DisplayPreview,
  formatIgnoredChannels,
  formatProfilePreviewMeta,
  type DisplayTouchLogDetail,
} from "./display-preview.js";
import {
  DeviceStudioAppEventLog,
  formatDeviceStudioEventForClipboard,
  type DeviceStudioAppEventLogEntry,
  type DeviceStudioAppEventInput,
} from "./event-log.js";
import {
  StackChanPreview,
  type StackChanPreviewModel,
} from "./stackchan-preview.js";

declare global {
  interface Window {
    __deviceStudioPreviewSnapshot?: () => StackChanPreviewModel | undefined;
  }
}

interface StudioState {
  profileId: string;
  backendMode: DeviceStudioTransportMode;
  selectedBehaviorId: string;
  selectedFrameIndex: number;
  elapsedMs: number;
}

type SpriteFrameKind = "expression" | "viseme";
type SpriteFrameSource = "generated" | "manual" | "sheet";
type SpriteOutputMode = "frame" | "sheet";
type SpriteGenerationMode = "text-to-image" | "image-to-image" | "edit";

interface SpriteCandidate {
  localId: string;
  kind: SpriteFrameKind;
  id: string;
  source: SpriteFrameSource;
  dataUrl?: string;
  url?: string;
  prompt?: string;
  modelId?: string;
  generatedAt?: string;
}

interface ApprovedSpriteFrame {
  kind: SpriteFrameKind;
  id: string;
  dataUrl: string;
  source: SpriteFrameSource;
  prompt?: string;
  modelId?: string;
  generatedAt?: string;
}

interface SpriteReferenceImage {
  localId: string;
  name: string;
  dataUrl: string;
  mimeType: string;
  sizeBytes: number;
}

interface SpriteSheetCandidate {
  localId: string;
  name: string;
  source: "generated" | "manual";
  dataUrl?: string;
  url?: string;
  prompt?: string;
  modelId?: string;
  generatedAt?: string;
}

interface SpritePackResult {
  atlasDataUrl: string;
  manifest: unknown;
}

let behaviorLibrary: BehaviorLibrary = createFixtureBehaviorLibrary();
const firstProfile = requireFirst(concreteDeviceProfiles, "Device Studio requires at least one profile");
const firstBehavior = requireFirst(
  behaviorLibrary.list({ profile: firstProfile, includeIncompatible: true }),
  "Device Studio requires at least one behavior",
);

const state: StudioState = {
  profileId: firstProfile.id,
  backendMode: "mock",
  selectedBehaviorId: firstBehavior.id,
  selectedFrameIndex: 0,
  elapsedMs: 0,
};

const spriteState: {
  references: SpriteReferenceImage[];
  sheets: SpriteSheetCandidate[];
  candidates: SpriteCandidate[];
  approved: ApprovedSpriteFrame[];
  lastPack?: SpritePackResult;
} = {
  references: [],
  sheets: [],
  candidates: [],
  approved: [],
};

let hubClient: DeviceStudioHubClient | null = null;
let hubClientConfigKey = "";
let hubUnsubscribes: DeviceStudioTransportUnsubscribe[] = [];
let activePlayback: BehaviorPlayback | null = null;
let animationFrameId: number | undefined;
let playbackStartedAt = 0;
let lastStackChanModel: StackChanPreviewModel | undefined;
let lastSheetTargetsTemplate = "";
const operationalLog = new DeviceStudioAppEventLog();

function requireElement<T extends HTMLElement>(id: string, type: { new(): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) {
    throw new Error(`Missing #${id}`);
  }
  return element;
}

function requireFirst<T>(values: readonly T[], message: string): T {
  const first = values[0];
  if (!first) {
    throw new Error(message);
  }
  return first;
}

const profileSelect = requireElement("profile-select", HTMLSelectElement);
const connectionBadge = requireElement("connection-badge", HTMLDivElement);
const connectionLabel = requireElement("connection-label", HTMLSpanElement);
const controlModeLabel = requireElement("control-mode-label", HTMLSpanElement);
const connectionStateValue = requireElement("connection-state-value", HTMLElement);
const sessionValue = requireElement("session-value", HTMLElement);
const activeProfileValue = requireElement("active-profile-value", HTMLElement);
const logCountValue = requireElement("log-count-value", HTMLElement);
const previewMeta = requireElement("preview-meta", HTMLDivElement);
const previewStage = requireElement("preview-stage", HTMLDivElement);
const displayPreviewRoot = requireElement("display-preview-root", HTMLDivElement);
const stackChanPreviewRoot = requireElement("stackchan-preview-root", HTMLDivElement);
const behaviorList = requireElement("behavior-list", HTMLDivElement);
const timeRuler = requireElement("time-ruler", HTMLDivElement);
const frameLane = requireElement("frame-lane", HTMLDivElement);
const eventLog = requireElement("event-log", HTMLOListElement);
const commandInput = requireElement("command-input", HTMLTextAreaElement);
const hubUrl = requireElement("hub-url", HTMLInputElement);
const connectButton = requireElement("connect-button", HTMLButtonElement);
const pingButton = requireElement("ping-button", HTMLButtonElement);
const interruptButton = requireElement("interrupt-button", HTMLButtonElement);
const sendCommandButton = requireElement("send-command-button", HTMLButtonElement);
const draftCommandButton = requireElement("draft-command-button", HTMLButtonElement);
const importBehaviorButton = requireElement("import-behavior-button", HTMLButtonElement);
const importBehaviorFile = requireElement("import-behavior-file", HTMLInputElement);
const exportBehaviorButton = requireElement("export-behavior-button", HTMLButtonElement);
const newBehaviorButton = requireElement("new-behavior-button", HTMLButtonElement);
const duplicateBehaviorButton = requireElement("duplicate-behavior-button", HTMLButtonElement);
const deleteBehaviorButton = requireElement("delete-behavior-button", HTMLButtonElement);
const behaviorNameInput = requireElement("behavior-name-input", HTMLInputElement);
const behaviorIdInput = requireElement("behavior-id-input", HTMLInputElement);
const behaviorDurationValue = requireElement("behavior-duration-value", HTMLElement);
const behaviorHardwareValue = requireElement("behavior-hardware-value", HTMLElement);
const frameSelect = requireElement("frame-select", HTMLSelectElement);
const addFrameButton = requireElement("add-frame-button", HTMLButtonElement);
const duplicateFrameButton = requireElement("duplicate-frame-button", HTMLButtonElement);
const deleteFrameButton = requireElement("delete-frame-button", HTMLButtonElement);
const frameTimeInput = requireElement("frame-time-input", HTMLInputElement);
const frameDurationInput = requireElement("frame-duration-input", HTMLInputElement);
const frameLabelInput = requireElement("frame-label-input", HTMLInputElement);
const expressionIdSelect = requireElement("expression-id-select", HTMLSelectElement);
const expressionEyesSelect = requireElement("expression-eyes-select", HTMLSelectElement);
const expressionMouthSelect = requireElement("expression-mouth-select", HTMLSelectElement);
const expressionIntensityInput = requireElement("expression-intensity-input", HTMLInputElement);
const visemeIdSelect = requireElement("viseme-id-select", HTMLSelectElement);
const visemeWeightInput = requireElement("viseme-weight-input", HTMLInputElement);
const displayModeSelect = requireElement("display-mode-select", HTMLSelectElement);
const backlightInput = requireElement("backlight-input", HTMLInputElement);
const displayBackgroundInput = requireElement("display-background-input", HTMLInputElement);
const displayTextInput = requireElement("display-text-input", HTMLInputElement);
const jointEditorRoot = requireElement("joint-editor-root", HTMLDivElement);
const ledEditorRoot = requireElement("led-editor-root", HTMLDivElement);
const playButton = requireElement("play-button", HTMLButtonElement);
const stopButton = requireElement("stop-button", HTMLButtonElement);
const copyLogButton = requireElement("copy-log-button", HTMLButtonElement);
const exportLogButton = requireElement("export-log-button", HTMLButtonElement);
const spriteOutputSelect = requireElement("sprite-output-select", HTMLSelectElement);
const spriteKindSelect = requireElement("sprite-kind-select", HTMLSelectElement);
const spriteTargetSelect = requireElement("sprite-target-select", HTMLSelectElement);
const spriteModeSelect = requireElement("sprite-mode-select", HTMLSelectElement);
const spriteModelInput = requireElement("sprite-model-input", HTMLInputElement);
const spriteSeedInput = requireElement("sprite-seed-input", HTMLInputElement);
const spriteReferenceInput = requireElement("sprite-reference-input", HTMLInputElement);
const spritePromptInput = requireElement("sprite-prompt-input", HTMLTextAreaElement);
const spriteSheetRowsInput = requireElement("sprite-sheet-rows-input", HTMLInputElement);
const spriteSheetColsInput = requireElement("sprite-sheet-cols-input", HTMLInputElement);
const spriteSheetTargetsInput = requireElement("sprite-sheet-targets-input", HTMLTextAreaElement);
const generateSpriteButton = requireElement("generate-sprite-button", HTMLButtonElement);
const importSpriteButton = requireElement("import-sprite-button", HTMLButtonElement);
const importSpriteSheetButton = requireElement("import-sprite-sheet-button", HTMLButtonElement);
const uploadSpriteReferenceButton = requireElement("upload-sprite-reference-button", HTMLButtonElement);
const clearSpriteReferencesButton = requireElement("clear-sprite-references-button", HTMLButtonElement);
const packSpritesButton = requireElement("pack-sprites-button", HTMLButtonElement);
const spriteReferenceFile = requireElement("sprite-reference-file", HTMLInputElement);
const spriteImportFile = requireElement("sprite-import-file", HTMLInputElement);
const spriteSheetFile = requireElement("sprite-sheet-file", HTMLInputElement);
const spriteStatus = requireElement("sprite-status", HTMLOutputElement);
const spriteReferenceGrid = requireElement("sprite-reference-grid", HTMLDivElement);
const spriteSheetGrid = requireElement("sprite-sheet-grid", HTMLDivElement);
const spriteCandidateGrid = requireElement("sprite-candidate-grid", HTMLDivElement);
const spriteApprovedGrid = requireElement("sprite-approved-grid", HTMLDivElement);

const displayPreview = new DisplayPreview(displayPreviewRoot, {
  onTouch: (detail) => recordDisplayTouch(detail),
});
const stackChanPreview = new StackChanPreview(stackChanPreviewRoot);
window.__deviceStudioPreviewSnapshot = () => lastStackChanModel;

function selectedProfile(): ConcreteDeviceProfile {
  const profile = getConcreteDeviceProfile(state.profileId);
  if (!profile) {
    throw new Error(`Unknown profile ${state.profileId}`);
  }
  return profile;
}

function behaviorEntries(profile = selectedProfile()): BehaviorLibraryEntry[] {
  return behaviorLibrary.list({ profile, includeIncompatible: true });
}

function allBehaviorTimelines(): BehaviorTimeline[] {
  return behaviorLibrary.list().map((entry) => entry.timeline);
}

function ensureSelectedBehavior(profile = selectedProfile()): void {
  const entries = behaviorEntries(profile);
  const selected = entries.find((entry) => entry.id === state.selectedBehaviorId);
  if (selected) {
    normalizeSelectedFrameIndex(behaviorLibrary.require(selected.id));
    return;
  }
  state.selectedBehaviorId = requireFirst(entries, "No behaviors available for selected profile").id;
  state.selectedFrameIndex = 0;
  state.elapsedMs = 0;
}

function selectedBehaviorEntry(): BehaviorLibraryEntry {
  ensureSelectedBehavior();
  const entry = behaviorEntries().find((candidate) => candidate.id === state.selectedBehaviorId);
  if (!entry) {
    throw new Error(`Unknown behavior ${state.selectedBehaviorId}`);
  }
  return entry;
}

function selectedBehaviorTimeline(): BehaviorTimeline {
  return behaviorLibrary.require(selectedBehaviorEntry().id);
}

function normalizeSelectedFrameIndex(timeline = selectedBehaviorTimeline()): void {
  const maxIndex = Math.max(0, timeline.frames.length - 1);
  state.selectedFrameIndex = Math.min(Math.max(state.selectedFrameIndex, 0), maxIndex);
}

function selectedFrame(timeline = selectedBehaviorTimeline()): BehaviorFrame {
  normalizeSelectedFrameIndex(timeline);
  return requireFirst(timeline.frames.slice(state.selectedFrameIndex, state.selectedFrameIndex + 1), "Selected behavior has no frames");
}

function sampleSelectedBehavior(elapsedMs = state.elapsedMs): NormalizedBehaviorRenderState {
  return sampleBehaviorRenderState(selectedBehaviorTimeline(), elapsedMs, { profile: selectedProfile() });
}

function activeSnapshot(): DeviceStudioTransportSnapshot | null {
  return hubClient?.snapshot() ?? null;
}

function activeSessionContext(): Pick<DeviceStudioAppEventInput, "mode" | "state" | "profileId" | "sessionId" | "channelId"> {
  const snapshot = activeSnapshot();
  return {
    mode: state.backendMode,
    state: snapshot?.state,
    profileId: selectedProfile().id,
    sessionId: snapshot?.session.sessionId,
    channelId: snapshot?.session.channelId,
  };
}

function recordEvent(input: DeviceStudioAppEventInput): void {
  operationalLog.append(input);
  renderEventLog();
}

function recordBehaviorEvent(event: BehaviorEvent): void {
  const context = activeSessionContext();
  operationalLog.appendBehaviorEvent(event, {
    mode: context.mode,
    profileId: context.profileId,
    sessionId: context.sessionId,
    channelId: context.channelId,
  });
  renderEventLog();
}

function recordDisplayTouch(detail: DisplayTouchLogDetail): void {
  recordEvent({
    ...activeSessionContext(),
    source: "user",
    kind: detail.type,
    summary: `${detail.gesture} ${detail.pixel.x},${detail.pixel.y}`,
    payload: detail,
  });
}

function recordHardwareVerification(subject: "profile" | "behavior"): void {
  const profile = selectedProfile();
  const entry = selectedBehaviorEntry();
  const payload = subject === "profile"
    ? {
        profile: verificationPayload(profile.id, profile.name, profile.hardwareVerification),
      }
    : {
        profile: verificationPayload(profile.id, profile.name, profile.hardwareVerification),
        behavior: verificationPayload(entry.id, entry.name, entry.timeline.hardwareVerification),
        compatible: entry.compatible,
        ignoredChannels: entry.ignoredChannels,
      };
  recordEvent({
    ...activeSessionContext(),
    source: "hardware verification",
    kind: `hardware.${subject}`,
    summary: subject === "profile" ? profile.hardwareVerification.status : entry.timeline.hardwareVerification.status,
    payload,
  });
}

function verificationPayload(id: string, name: string, verification: HardwareVerification): unknown {
  return {
    id,
    name,
    status: verification.status,
    label: verification.label,
    verifiedAt: verification.verifiedAt,
    verifiedBy: verification.verifiedBy,
    notes: verification.notes,
  };
}

function createAuthoringVerification(): HardwareVerification {
  return {
    status: "simulated-only",
    label: "Authored in Device Studio; not verified on hardware",
  };
}

function createAuthoringProvenance(label: string): BehaviorTimeline["provenance"] {
  return {
    label,
    source: "user-authored",
  };
}

function createDefaultFrame(profile = selectedProfile()): BehaviorFrame {
  const joints = Object.fromEntries(profile.joints.map((joint) => [joint.id, { value: joint.neutral }]));
  const leds = Object.fromEntries(profile.leds.map((led) => [led.id, {
    color: "#42f57b",
    brightness: 0.7,
    effect: "solid" as const,
  }]));
  return {
    atMs: 0,
    durationMs: 600,
    label: "Frame 1",
    expression: {
      id: profile.face.expressions[0] ?? "neutral",
      intensity: 1,
      eyes: "open",
      mouth: "neutral",
    },
    viseme: {
      id: profile.face.visemes[0] ?? "rest",
      weight: 1,
    },
    display: {
      mode: "face",
      backgroundColor: "#101918",
    },
    backlight: {
      brightness: profile.backlight.supported ? 0.82 : 0,
    },
    ...(Object.keys(joints).length > 0 ? { joints } : {}),
    ...(Object.keys(leds).length > 0 ? { leds } : {}),
    hardwareVerification: createAuthoringVerification(),
  };
}

function createEditableBehaviorTimeline(name: string, source?: BehaviorTimeline): BehaviorTimeline {
  const profile = selectedProfile();
  const baseId = slugifyBehaviorId(name || "custom behavior");
  const id = uniqueBehaviorId(source ? `${baseId}.copy` : baseId);
  const frames = source
    ? source.frames.map((frame) => cloneJsonish(frame))
    : [createDefaultFrame(profile)];
  return {
    id,
    name: name || "Custom Behavior",
    compatibleProfileIds: [profile.id],
    channels: inferTimelineChannels(frames),
    durationMs: calculateTimelineDuration(frames),
    frames,
    provenance: createAuthoringProvenance(source ? `Duplicated from ${source.name}` : "Device Studio authoring"),
    hardwareVerification: createAuthoringVerification(),
  };
}

function replaceBehaviorTimeline(timeline: BehaviorTimeline): void {
  const timelines = allBehaviorTimelines().filter((candidate) => candidate.id !== timeline.id);
  behaviorLibrary = new BehaviorLibrary([...timelines, {
    ...timeline,
    channels: inferTimelineChannels(timeline.frames),
    durationMs: calculateTimelineDuration(timeline.frames),
    hardwareVerification: timeline.hardwareVerification ?? createAuthoringVerification(),
    provenance: timeline.provenance ?? createAuthoringProvenance("Device Studio authoring"),
  }]);
  state.selectedBehaviorId = timeline.id;
  normalizeSelectedFrameIndex();
}

function deleteBehaviorTimeline(id: string): void {
  const remaining = allBehaviorTimelines().filter((timeline) => timeline.id !== id);
  if (remaining.length === 0) {
    return;
  }
  behaviorLibrary = new BehaviorLibrary(remaining);
  state.selectedBehaviorId = remaining[0]?.id ?? state.selectedBehaviorId;
  state.selectedFrameIndex = 0;
  state.elapsedMs = 0;
}

function updateSelectedTimeline(
  update: (timeline: BehaviorTimeline) => BehaviorTimeline,
  eventSummary: string,
): void {
  stopActivePlayback("edited");
  const previous = selectedBehaviorTimeline();
  const next = update(cloneJsonish(previous));
  replaceBehaviorTimeline(next);
  const frame = selectedFrame();
  state.elapsedMs = frame.atMs;
  renderBehaviorList();
  renderBehavior();
  renderAuthoringEditor();
  recordEvent({
    ...activeSessionContext(),
    source: "user editing",
    kind: "behavior.edit",
    summary: eventSummary,
    payload: {
      behaviorId: state.selectedBehaviorId,
      frameIndex: state.selectedFrameIndex,
      hardwareVerificationStatus: selectedBehaviorTimeline().hardwareVerification.status,
    },
  });
}

function updateSelectedFrame(
  update: (frame: BehaviorFrame, timeline: BehaviorTimeline) => BehaviorFrame,
  eventSummary: string,
): void {
  updateSelectedTimeline((timeline) => {
    const frames = timeline.frames.map((frame, index) => {
      if (index !== state.selectedFrameIndex) {
        return frame;
      }
      return {
        ...update(cloneJsonish(frame), timeline),
        hardwareVerification: createAuthoringVerification(),
      };
    });
    return {
      ...timeline,
      frames,
      channels: inferTimelineChannels(frames),
      durationMs: calculateTimelineDuration(frames),
      hardwareVerification: createAuthoringVerification(),
      provenance: createAuthoringProvenance("Edited in Device Studio"),
    };
  }, eventSummary);
}

function inferTimelineChannels(frames: BehaviorFrame[]): BehaviorChannel[] {
  const channels = new Set<BehaviorChannel>();
  for (const frame of frames) {
    if (frame.expression) channels.add("expression");
    if (frame.viseme) channels.add("viseme");
    if (frame.display) channels.add("display");
    if (frame.backlight) channels.add("backlight");
    if (frame.joints && Object.keys(frame.joints).length > 0) channels.add("joints");
    if (frame.leds && Object.keys(frame.leds).length > 0) channels.add("leds");
  }
  const order: BehaviorChannel[] = ["expression", "viseme", "joints", "display", "backlight", "leds"];
  return order.filter((channel) => channels.has(channel));
}

function calculateTimelineDuration(frames: BehaviorFrame[]): number {
  return Math.max(1, ...frames.map((frame) => frame.atMs + (frame.durationMs ?? 0)));
}

function slugifyBehaviorId(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `behavior.${slug || "custom"}`;
}

function uniqueBehaviorId(baseId: string): string {
  const existing = new Set(allBehaviorTimelines().map((timeline) => timeline.id));
  if (!existing.has(baseId)) {
    return baseId;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseId}-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  return `${baseId}-${Date.now()}`;
}

function cloneJsonish<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function renderProfileOptions(): void {
  profileSelect.replaceChildren(...concreteDeviceProfiles.map((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    return option;
  }));
}

function renderProfile(): void {
  const profile = selectedProfile();
  profileSelect.value = profile.id;
  previewMeta.textContent = formatProfilePreviewMeta(profile);
  activeProfileValue.textContent = profile.id;
  previewStage.dataset.profile = profile.family;
  previewStage.dataset.hardware = profile.hardwareVerification.status;
  displayPreview.setProfile(profile);
}

function renderMode(): void {
  const snapshot = activeSnapshot();
  const connectionState: DeviceStudioConnectionState = snapshot?.state ?? "idle";
  const ready = snapshot?.ready ?? false;
  const connected = isActiveConnectionState(connectionState);
  const modeLabel = state.backendMode === "mock" ? "Mock" : "Live";

  connectionBadge.dataset.mode = state.backendMode;
  connectionBadge.dataset.connected = String(connected);
  connectionLabel.textContent = `${modeLabel} ${ready ? "ready" : connectionState}`;
  controlModeLabel.textContent = `${modeLabel} backend`;
  connectionStateValue.textContent = connectionState;
  sessionValue.textContent = snapshot?.session.sessionId ?? "not attached";
  connectButton.textContent = connected ? "Disconnect" : "Connect";
  pingButton.disabled = !connected;
  interruptButton.disabled = !connected;
}

function renderBehavior(): void {
  applyRenderStateToPreview(sampleSelectedBehavior());
  renderFrameLane();
}

function renderAuthoringEditor(): void {
  const profile = selectedProfile();
  const timeline = selectedBehaviorTimeline();
  normalizeSelectedFrameIndex(timeline);
  const frame = selectedFrame(timeline);
  const renderState = sampleSelectedBehavior(frame.atMs);

  behaviorNameInput.value = timeline.name;
  behaviorIdInput.value = timeline.id;
  behaviorDurationValue.textContent = `${calculateTimelineDuration(timeline.frames)} ms`;
  behaviorHardwareValue.textContent = timeline.hardwareVerification.status;
  deleteBehaviorButton.disabled = allBehaviorTimelines().length <= 1;

  frameSelect.replaceChildren(...timeline.frames.map((candidate, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${index + 1} / ${candidate.atMs} ms / ${candidate.label ?? "frame"}`;
    return option;
  }));
  frameSelect.value = String(state.selectedFrameIndex);
  deleteFrameButton.disabled = timeline.frames.length <= 1;
  duplicateFrameButton.disabled = timeline.frames.length === 0;

  frameTimeInput.value = String(frame.atMs);
  frameDurationInput.value = String(frame.durationMs ?? 0);
  frameLabelInput.value = frame.label ?? "";

  renderOptionSelect(expressionIdSelect, profile.face.expressions, frame.expression?.id ?? renderState.expression?.id ?? "neutral");
  renderOptionSelect(visemeIdSelect, profile.face.visemes, frame.viseme?.id ?? renderState.viseme?.id ?? "rest");
  expressionEyesSelect.value = frame.expression?.eyes ?? renderState.expression?.eyes ?? "open";
  expressionMouthSelect.value = frame.expression?.mouth ?? renderState.expression?.mouth ?? "neutral";
  expressionIntensityInput.value = String(frame.expression?.intensity ?? renderState.expression?.intensity ?? 1);
  visemeWeightInput.value = String(frame.viseme?.weight ?? renderState.viseme?.weight ?? 1);
  displayModeSelect.value = frame.display?.mode ?? renderState.display?.mode ?? "face";
  displayBackgroundInput.value = normalizeColor(frame.display?.backgroundColor ?? renderState.display?.backgroundColor ?? "#101918");
  displayTextInput.value = frame.display?.text ?? renderState.display?.text ?? "";
  backlightInput.value = String(frame.backlight?.brightness ?? renderState.backlight?.brightness ?? 0.82);

  const supportsExpression = profile.capabilities.output.includes("expression");
  const supportsViseme = profile.capabilities.output.includes("viseme");
  const supportsDisplay = profile.capabilities.output.includes("display");
  expressionIdSelect.disabled = !supportsExpression;
  expressionEyesSelect.disabled = !supportsExpression;
  expressionMouthSelect.disabled = !supportsExpression;
  expressionIntensityInput.disabled = !supportsExpression;
  visemeIdSelect.disabled = !supportsViseme;
  visemeWeightInput.disabled = !supportsViseme;
  displayModeSelect.disabled = !supportsDisplay;
  displayBackgroundInput.disabled = !supportsDisplay;
  displayTextInput.disabled = !supportsDisplay || displayModeSelect.value !== "text";
  backlightInput.disabled = !profile.backlight.supported;

  renderJointEditor(profile, frame);
  renderLedEditor(profile, frame);
}

function renderOptionSelect(select: HTMLSelectElement, values: readonly string[], selectedValue: string): void {
  const uniqueValues = [...new Set([selectedValue, ...values].filter(Boolean))];
  select.replaceChildren(...uniqueValues.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    return option;
  }));
  select.value = selectedValue;
}

function renderJointEditor(profile: ConcreteDeviceProfile, frame: BehaviorFrame): void {
  if (profile.joints.length === 0) {
    jointEditorRoot.replaceChildren();
    jointEditorRoot.hidden = true;
    return;
  }

  jointEditorRoot.hidden = false;
  jointEditorRoot.replaceChildren(...profile.joints.map((joint) => {
    const value = frame.joints?.[joint.id]?.value ?? joint.neutral;
    const row = document.createElement("label");
    row.className = "channel-row";
    const name = document.createElement("span");
    name.textContent = joint.name;
    const range = document.createElement("input");
    range.type = "range";
    range.min = String(joint.min);
    range.max = String(joint.max);
    range.step = "1";
    range.value = String(value);
    const number = document.createElement("input");
    number.type = "number";
    number.min = String(joint.min);
    number.max = String(joint.max);
    number.step = "1";
    number.value = String(value);
    const applyValue = (raw: string): void => {
      const nextValue = clampNumber(Number(raw), joint.min, joint.max);
      range.value = String(nextValue);
      number.value = String(nextValue);
      updateSelectedFrame((current) => ({
        ...current,
        joints: {
          ...(current.joints ?? {}),
          [joint.id]: { value: nextValue },
        },
      }), `${joint.id} ${nextValue}${joint.unit === "degrees" ? "deg" : "mm"}`);
    };
    range.addEventListener("input", () => applyValue(range.value));
    number.addEventListener("change", () => applyValue(number.value));
    row.append(name, range, number);
    return row;
  }));
}

function renderLedEditor(profile: ConcreteDeviceProfile, frame: BehaviorFrame): void {
  if (profile.leds.length === 0) {
    ledEditorRoot.replaceChildren();
    ledEditorRoot.hidden = true;
    return;
  }

  ledEditorRoot.hidden = false;
  ledEditorRoot.replaceChildren(...profile.leds.map((led) => {
    const current = frame.leds?.[led.id] ?? {};
    const row = document.createElement("label");
    row.className = "channel-row led-row";
    const name = document.createElement("span");
    name.textContent = led.name;
    const color = document.createElement("input");
    color.type = "color";
    color.value = normalizeColor(current.color ?? "#42f57b");
    const brightness = document.createElement("input");
    brightness.type = "range";
    brightness.min = "0";
    brightness.max = "1";
    brightness.step = "0.05";
    brightness.value = String(current.brightness ?? 0.7);
    const effect = document.createElement("select");
    renderOptionSelect(effect, ["solid", "pulse", "blink", "off"], current.effect ?? "solid");
    const applyLed = (): void => {
      const value: LedFrameState = {
        color: color.value,
        brightness: clampUnitNumber(Number(brightness.value)),
        effect: effect.value as LedFrameState["effect"],
      };
      updateSelectedFrame((currentFrame) => ({
        ...currentFrame,
        leds: {
          ...(currentFrame.leds ?? {}),
          [led.id]: value,
        },
      }), `${led.id} ${value.effect ?? "solid"}`);
    };
    color.addEventListener("input", applyLed);
    brightness.addEventListener("input", applyLed);
    effect.addEventListener("change", applyLed);
    row.append(name, color, brightness, effect);
    return row;
  }));
}

function normalizeColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#101918";
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function clampUnitNumber(value: number): number {
  return clampNumber(value, 0, 1);
}

function applyRenderStateToPreview(renderState: NormalizedBehaviorRenderState): void {
  state.elapsedMs = renderState.elapsedMs;
  previewStage.dataset.hardwareVerified = String(renderState.hardwareVerified);
  displayPreview.render(renderState);
  lastStackChanModel = stackChanPreview.update(selectedProfile(), renderState);
}

function renderFrameLane(): void {
  const timeline = selectedBehaviorTimeline();
  const renderState = sampleSelectedBehavior();
  const durationMs = Math.max(renderState.durationMs, timeline.durationMs ?? 0, 1);
  timeRuler.replaceChildren(...[0, durationMs / 3, (durationMs * 2) / 3, durationMs].map((time) => {
    const marker = document.createElement("span");
    marker.textContent = `${Math.round(time)} ms`;
    return marker;
  }));
  frameLane.replaceChildren(...timeline.frames.map((frame, index) => {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "frame-marker";
    marker.style.left = `${Math.min(96, Math.max(4, (frame.atMs / durationMs) * 100))}%`;
    marker.textContent = String(index + 1);
    marker.dataset.active = String(renderState.activeFrame?.index === index);
    marker.setAttribute("aria-label", `Frame ${index + 1} at ${frame.atMs} milliseconds`);
    marker.addEventListener("click", () => {
      state.selectedFrameIndex = index;
      applyBehaviorFrame(frame.atMs);
      renderAuthoringEditor();
    });
    return marker;
  }));
}

function renderBehaviorList(): void {
  const entries = behaviorEntries();
  if (entries.length === 0) {
    behaviorList.replaceChildren();
    return;
  }
  ensureSelectedBehavior();
  behaviorList.replaceChildren(...entries.map((entry) => {
    const renderState = sampleBehaviorRenderState(behaviorLibrary.require(entry.id), 0, { profile: selectedProfile() });
    const button = document.createElement("button");
    button.type = "button";
    button.className = "behavior-card";
    button.dataset.selected = String(entry.id === state.selectedBehaviorId);
    button.dataset.compatible = String(entry.compatible);
    const label = document.createElement("strong");
    label.textContent = entry.name;
    const stateLine = document.createElement("span");
    stateLine.textContent = [
      renderState.expression?.id ?? "none",
      renderState.viseme?.id ?? "rest",
      entry.supportedChannels.join(", ") || "no preview channels",
    ].join(" / ");
    const provenance = document.createElement("small");
    provenance.textContent = `${entry.provenanceSource} / ${entry.hardwareVerificationStatus}`;
    button.append(label, stateLine, provenance);
    if (entry.ignoredChannels.length > 0) {
      const ignored = document.createElement("small");
      ignored.className = "ignored-channel-note";
      ignored.textContent = `Drops ${formatIgnoredChannels(entry.ignoredChannels)}`;
      button.append(ignored);
    }
    button.addEventListener("click", () => {
      stopActivePlayback("behavior changed");
      state.selectedBehaviorId = entry.id;
      state.selectedFrameIndex = 0;
      state.elapsedMs = 0;
      renderBehaviorList();
      renderBehavior();
      renderAuthoringEditor();
      recordEvent({
        ...activeSessionContext(),
        source: "behavior",
        kind: "behavior.select",
        summary: entry.name,
        payload: {
          id: entry.id,
          name: entry.name,
          provenanceSource: entry.provenanceSource,
          hardwareVerificationStatus: entry.hardwareVerificationStatus,
          compatible: entry.compatible,
          ignoredChannels: entry.ignoredChannels,
        },
      });
      recordHardwareVerification("behavior");
    });
    return button;
  }));
}

function renderEventLog(): void {
  const entries = [...operationalLog.entries].slice(-80);
  logCountValue.textContent = String(operationalLog.entries.length);
  eventLog.replaceChildren(...entries.map((entry) => {
    const item = document.createElement("li");
    item.dataset.source = entry.source;

    const meta = document.createElement("div");
    meta.className = "event-meta";

    const timeElement = document.createElement("time");
    timeElement.dateTime = entry.at;
    timeElement.textContent = new Date(entry.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const sourceElement = document.createElement("span");
    sourceElement.className = "source-pill";
    sourceElement.textContent = entry.source;

    const directionElement = document.createElement("span");
    directionElement.className = "event-direction";
    directionElement.textContent = entry.direction ?? "internal";

    meta.append(timeElement, sourceElement, directionElement);

    const body = document.createElement("div");
    body.className = "event-body";

    const title = document.createElement("strong");
    title.textContent = entry.kind;

    const detailLine = document.createElement("span");
    detailLine.textContent = [
      entry.summary,
      entry.messageType,
      entry.profileId,
      entry.sessionId,
    ].filter(Boolean).join(" / ");

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Event";
    const payload = document.createElement("pre");
    payload.textContent = JSON.stringify(createEventLogPreview(entry), null, 2);
    details.append(summary, payload);

    body.append(title, detailLine, details);
    item.append(meta, body);
    return item;
  }));
  eventLog.scrollTop = eventLog.scrollHeight;
}

function createEventLogPreview(entry: DeviceStudioAppEventLogEntry): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      id: entry.id,
      at: entry.at,
      source: entry.source,
      kind: entry.kind,
      mode: entry.mode,
      state: entry.state,
      direction: entry.direction,
      profileId: entry.profileId,
      sessionId: entry.sessionId,
      channelId: entry.channelId,
      messageType: entry.messageType,
      summary: entry.summary,
      error: entry.error,
    }).filter(([, value]) => value !== undefined),
  );
}

function render(): void {
  ensureSelectedBehavior();
  renderProfile();
  renderMode();
  renderBehaviorList();
  renderBehavior();
  renderAuthoringEditor();
  renderSpriteWorkspace();
  renderEventLog();
}

function ensureHubClient(): DeviceStudioHubClient {
  if (hubClient && hubClient.snapshot().mode === state.backendMode && hubClientConfigKey === desiredHubClientConfigKey()) {
    return hubClient;
  }
  replaceHubClient();
  if (!hubClient) {
    throw new Error("Device Studio hub client was not initialized");
  }
  return hubClient;
}

function replaceHubClient(): void {
  const previous = hubClient;
  if (previous && isActiveConnectionState(previous.snapshot().state)) {
    previous.disconnect();
  }
  for (const unsubscribe of hubUnsubscribes) {
    unsubscribe();
  }
  hubUnsubscribes = [];

  const profile = selectedProfile();
  hubClientConfigKey = desiredHubClientConfigKey();
  hubClient = new DeviceStudioHubClient({
    mode: state.backendMode,
    url: hubUrl.value,
    profile,
    mock: {
      assistantText: `Mock ${profile.name} response from Device Studio.`,
      assistantLiveDeltas: ["Mock transport ", "accepted the typed turn."],
    },
  });
  hubUnsubscribes = [
    hubClient.on("log", (entry) => {
      const snapshot = activeSnapshot();
      operationalLog.appendTransportLog(entry, {
        mode: snapshot?.mode ?? state.backendMode,
        profileId: entry.profileId ?? profile.id,
        sessionId: entry.sessionId ?? snapshot?.session.sessionId,
        channelId: entry.channelId ?? snapshot?.session.channelId,
      });
      renderMode();
      renderEventLog();
    }),
    hubClient.on("message", (event) => {
      if (event.final && event.role === "assistant") {
        stopActivePlayback("assistant final", false);
      }
    }),
    hubClient.on("lifecycle", (event) => {
      if (event.name === "assistant.interrupted" || event.name === "action.interrupt") {
        stopActivePlayback("transport interrupt");
      }
      renderMode();
    }),
    hubClient.on("state", () => renderMode()),
    hubClient.on("error", () => renderMode()),
  ];

  recordEvent({
    ...activeSessionContext(),
    source: "transport",
    kind: "transport.client.ready",
    summary: `${state.backendMode} adapter`,
    payload: hubClient.snapshot().hello,
  });
}

function desiredHubClientConfigKey(): string {
  const liveUrl = state.backendMode === "live" ? hubUrl.value.trim() : "mock";
  return `${state.backendMode}:${selectedProfile().id}:${liveUrl}`;
}

function isActiveConnectionState(connectionState: DeviceStudioConnectionState): boolean {
  return connectionState === "connecting" || connectionState === "connected" || connectionState === "ready";
}

async function toggleConnection(): Promise<void> {
  const client = ensureHubClient();
  const snapshot = client.snapshot();
  if (isActiveConnectionState(snapshot.state)) {
    client.disconnect();
    renderMode();
    return;
  }

  try {
    await client.connect();
    renderMode();
  } catch (error) {
    recordEvent({
      ...activeSessionContext(),
      source: "transport",
      kind: "transport.connect.failed",
      summary: error instanceof Error ? error.message : "Connection failed",
      error: error instanceof Error ? error.message : String(error),
    });
    renderMode();
  }
}

async function sendTypedTurn(): Promise<void> {
  const text = commandInput.value.trim();
  if (!text) {
    recordEvent({
      ...activeSessionContext(),
      source: "user",
      kind: "command.rejected",
      summary: "empty typed turn",
      payload: { text },
    });
    return;
  }

  const client = ensureHubClient();
  try {
    if (!isActiveConnectionState(client.snapshot().state)) {
      await client.connect();
    }
    client.sendUserText(text, { interrupt: true });
  } catch (error) {
    recordEvent({
      ...activeSessionContext(),
      source: "user",
      kind: "command.failed",
      summary: error instanceof Error ? error.message : "Command failed",
      error: error instanceof Error ? error.message : String(error),
      payload: { text },
    });
  }
}

function stopActivePlayback(reason: string, emit = true): void {
  if (animationFrameId !== undefined) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = undefined;
  }
  const playback = activePlayback;
  activePlayback = null;
  if (playback && emit) {
    applyRenderStateToPreview(playback.stop(reason, state.elapsedMs));
  }
}

function createSelectedPlayback(): BehaviorPlayback {
  return createBehaviorPlayback({
    timeline: selectedBehaviorTimeline(),
    profile: selectedProfile(),
    emit: recordBehaviorEvent,
  });
}

function playSelectedBehavior(): void {
  stopActivePlayback("restarted");
  activePlayback = createSelectedPlayback();
  const started = activePlayback.start(0);
  playbackStartedAt = performance.now() - started.elapsedMs;
  applyRenderStateToPreview(started);
  schedulePlaybackTick();
}

function schedulePlaybackTick(): void {
  animationFrameId = requestAnimationFrame((timestamp) => {
    const playback = activePlayback;
    if (!playback) {
      animationFrameId = undefined;
      return;
    }
    const renderState = playback.sample(timestamp - playbackStartedAt);
    applyRenderStateToPreview(renderState);
    renderFrameLane();
    if (renderState.complete) {
      stopActivePlayback("complete");
      return;
    }
    schedulePlaybackTick();
  });
}

function applyBehaviorFrame(elapsedMs: number): void {
  if (!activePlayback) {
    activePlayback = createSelectedPlayback();
    applyRenderStateToPreview(activePlayback.start(0));
  }
  applyRenderStateToPreview(activePlayback.sample(elapsedMs));
  renderFrameLane();
}

function createDraftCommand(): void {
  const entry = selectedBehaviorEntry();
  const profile = selectedProfile();
  const channels = entry.supportedChannels.join(", ");
  commandInput.value = `Draft a ${entry.name} turn for ${profile.name}. Use supported channels: ${channels}. Keep motion hardware-safe and report any unverified output before applying it.`;
  recordEvent({
    ...activeSessionContext(),
    source: "user",
    kind: "draft.generate",
    summary: entry.name,
    payload: {
      behaviorId: entry.id,
      profileId: profile.id,
      supportedChannels: entry.supportedChannels,
      ignoredChannels: entry.ignoredChannels,
    },
  });
}

function createNewBehavior(): void {
  const timeline = createEditableBehaviorTimeline("Custom Behavior");
  replaceBehaviorTimeline(timeline);
  state.selectedFrameIndex = 0;
  state.elapsedMs = 0;
  render();
  recordEvent({
    ...activeSessionContext(),
    source: "user editing",
    kind: "behavior.create",
    summary: timeline.name,
    payload: { behaviorId: timeline.id, profileId: selectedProfile().id },
  });
}

function duplicateSelectedBehavior(): void {
  const source = selectedBehaviorTimeline();
  const timeline = createEditableBehaviorTimeline(`${source.name} Copy`, source);
  replaceBehaviorTimeline(timeline);
  state.selectedFrameIndex = 0;
  state.elapsedMs = 0;
  render();
  recordEvent({
    ...activeSessionContext(),
    source: "user editing",
    kind: "behavior.duplicate",
    summary: timeline.name,
    payload: { behaviorId: timeline.id, sourceBehaviorId: source.id },
  });
}

function deleteSelectedBehavior(): void {
  const timeline = selectedBehaviorTimeline();
  deleteBehaviorTimeline(timeline.id);
  stopActivePlayback("behavior deleted");
  render();
  recordEvent({
    ...activeSessionContext(),
    source: "user editing",
    kind: "behavior.delete",
    summary: timeline.name,
    payload: { behaviorId: timeline.id },
  });
}

function updateSelectedBehaviorName(): void {
  const name = behaviorNameInput.value.trim() || "Custom Behavior";
  updateSelectedTimeline((timeline) => ({
    ...timeline,
    name,
    provenance: createAuthoringProvenance("Renamed in Device Studio"),
    hardwareVerification: createAuthoringVerification(),
  }), `name ${name}`);
}

function addBehaviorFrame(): void {
  const timeline = selectedBehaviorTimeline();
  const current = selectedFrame(timeline);
  const nextFrame: BehaviorFrame = {
    ...cloneJsonish(current),
    atMs: current.atMs + (current.durationMs ?? 250),
    label: `Frame ${timeline.frames.length + 1}`,
    hardwareVerification: createAuthoringVerification(),
  };
  updateSelectedTimeline((currentTimeline) => {
    const frames = [...currentTimeline.frames, nextFrame].sort((left, right) => left.atMs - right.atMs);
    state.selectedFrameIndex = frames.findIndex((frame) => frame === nextFrame);
    return {
      ...currentTimeline,
      frames,
      channels: inferTimelineChannels(frames),
      durationMs: calculateTimelineDuration(frames),
      hardwareVerification: createAuthoringVerification(),
      provenance: createAuthoringProvenance("Edited in Device Studio"),
    };
  }, "frame added");
}

function duplicateBehaviorFrame(): void {
  const timeline = selectedBehaviorTimeline();
  const current = selectedFrame(timeline);
  const copy: BehaviorFrame = {
    ...cloneJsonish(current),
    atMs: current.atMs + 100,
    label: `${current.label ?? `Frame ${state.selectedFrameIndex + 1}`} copy`,
    hardwareVerification: createAuthoringVerification(),
  };
  updateSelectedTimeline((currentTimeline) => {
    const frames = [...currentTimeline.frames, copy].sort((left, right) => left.atMs - right.atMs);
    state.selectedFrameIndex = frames.findIndex((frame) => frame === copy);
    return {
      ...currentTimeline,
      frames,
      channels: inferTimelineChannels(frames),
      durationMs: calculateTimelineDuration(frames),
      hardwareVerification: createAuthoringVerification(),
      provenance: createAuthoringProvenance("Edited in Device Studio"),
    };
  }, "frame duplicated");
}

function deleteBehaviorFrame(): void {
  const timeline = selectedBehaviorTimeline();
  if (timeline.frames.length <= 1) {
    return;
  }
  const deletedIndex = state.selectedFrameIndex;
  updateSelectedTimeline((currentTimeline) => {
    const frames = currentTimeline.frames.filter((_, index) => index !== deletedIndex);
    state.selectedFrameIndex = Math.min(deletedIndex, frames.length - 1);
    return {
      ...currentTimeline,
      frames,
      channels: inferTimelineChannels(frames),
      durationMs: calculateTimelineDuration(frames),
      hardwareVerification: createAuthoringVerification(),
      provenance: createAuthoringProvenance("Edited in Device Studio"),
    };
  }, "frame deleted");
}

function selectFrame(index: number): void {
  const timeline = selectedBehaviorTimeline();
  state.selectedFrameIndex = Math.min(Math.max(index, 0), timeline.frames.length - 1);
  state.elapsedMs = selectedFrame(timeline).atMs;
  applyBehaviorFrame(state.elapsedMs);
  renderAuthoringEditor();
}

function updateFrameTiming(): void {
  updateSelectedFrame((frame) => ({
    ...frame,
    atMs: Math.max(0, Math.round(Number(frameTimeInput.value) || 0)),
    durationMs: Math.max(0, Math.round(Number(frameDurationInput.value) || 0)),
    label: frameLabelInput.value.trim() || undefined,
  }), "frame timing");
}

function updateFrameExpression(): void {
  const expression: ExpressionState = {
    id: expressionIdSelect.value,
    eyes: expressionEyesSelect.value as ExpressionState["eyes"],
    mouth: expressionMouthSelect.value as ExpressionState["mouth"],
    intensity: clampUnitNumber(Number(expressionIntensityInput.value)),
  };
  updateSelectedFrame((frame) => ({ ...frame, expression }), `expression ${expression.id}`);
}

function updateFrameViseme(): void {
  const viseme: VisemeState = {
    id: visemeIdSelect.value,
    weight: clampUnitNumber(Number(visemeWeightInput.value)),
  };
  updateSelectedFrame((frame) => ({ ...frame, viseme }), `viseme ${viseme.id}`);
}

function updateFrameDisplay(): void {
  const mode = displayModeSelect.value as DisplayFrameState["mode"];
  const display: DisplayFrameState = {
    mode,
    backgroundColor: displayBackgroundInput.value,
    ...(mode === "text" ? { text: displayTextInput.value } : {}),
    ...(mode === "image" ? { assetId: `${spriteKindSelect.value}:${spriteTargetSelect.value}` } : {}),
  };
  updateSelectedFrame((frame) => ({ ...frame, display }), `display ${display.mode}`);
}

function updateFrameBacklight(): void {
  updateSelectedFrame((frame) => ({
    ...frame,
    backlight: { brightness: clampUnitNumber(Number(backlightInput.value)) },
  }), "backlight");
}

function exportSelectedBehavior(): void {
  const timeline = selectedBehaviorTimeline();
  const json = exportBehaviorTimeline(timeline, { emit: recordBehaviorEvent, space: 2 });
  downloadText(`device-studio-${timeline.id}.json`, json, "application/json");
}

async function importBehaviorFileSelection(): Promise<void> {
  const file = importBehaviorFile.files?.[0];
  if (!file) {
    return;
  }
  try {
    const text = await file.text();
    behaviorLibrary = importBehaviorLibraryJson(text, { emit: recordBehaviorEvent });
    const first = behaviorEntries()[0];
    if (first) {
      state.selectedBehaviorId = first.id;
    }
    state.elapsedMs = 0;
    stopActivePlayback("imported library");
    renderBehaviorList();
    renderBehavior();
  } catch (error) {
    recordEvent({
      ...activeSessionContext(),
      source: "import/export",
      kind: "behavior.import.failed",
      summary: error instanceof Error ? error.message : "Import failed",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    importBehaviorFile.value = "";
  }
}

function renderSpriteWorkspace(): void {
  const profile = selectedProfile();
  const kind = selectedSpriteKind();
  const targets = selectedSpriteTargets(profile);
  renderOptionSelect(spriteTargetSelect, targets, targets.includes(spriteTargetSelect.value) ? spriteTargetSelect.value : targets[0] ?? "neutral");
  const nextSheetTargetsTemplate = createDefaultSheetTargetText(kind, targets);
  if (!spriteSheetTargetsInput.value.trim() || spriteSheetTargetsInput.value === lastSheetTargetsTemplate) {
    spriteSheetTargetsInput.value = nextSheetTargetsTemplate;
  }
  lastSheetTargetsTemplate = nextSheetTargetsTemplate;

  const output = selectedSpriteOutput();
  generateSpriteButton.textContent = output === "sheet" ? "Generate Sheet" : "Generate Frame";
  clearSpriteReferencesButton.disabled = spriteState.references.length === 0;
  spriteStatus.value = [
    `${spriteState.approved.length} approved`,
    `${spriteState.candidates.length} frame candidates`,
    `${spriteState.sheets.length} sheets`,
    `${spriteState.references.length} references`,
  ].join(" / ");
  packSpritesButton.disabled = spriteState.approved.length === 0;

  spriteReferenceGrid.replaceChildren(...spriteState.references.map(createSpriteReferenceCard));
  spriteSheetGrid.replaceChildren(...spriteState.sheets.map(createSpriteSheetCard));
  spriteCandidateGrid.replaceChildren(...spriteState.candidates.map((candidate) => createSpriteCard(candidate, false)));
  spriteApprovedGrid.replaceChildren(
    ...spriteState.approved.map((frame) => createSpriteCard({
      localId: `approved:${frame.kind}:${frame.id}`,
      kind: frame.kind,
      id: frame.id,
      source: frame.source,
      dataUrl: frame.dataUrl,
      prompt: frame.prompt,
      modelId: frame.modelId,
      generatedAt: frame.generatedAt,
    }, true)),
    ...(spriteState.lastPack ? [createPackResultCard(spriteState.lastPack)] : []),
  );
}

function selectedSpriteKind(): SpriteFrameKind {
  return spriteKindSelect.value === "viseme" ? "viseme" : "expression";
}

function selectedSpriteOutput(): SpriteOutputMode {
  return spriteOutputSelect.value === "sheet" ? "sheet" : "frame";
}

function selectedSpriteMode(): SpriteGenerationMode {
  const value = spriteModeSelect.value;
  return value === "image-to-image" || value === "edit" ? value : "text-to-image";
}

function selectedSpriteTargets(profile = selectedProfile()): readonly string[] {
  return selectedSpriteKind() === "expression" ? profile.face.expressions : profile.face.visemes;
}

function createDefaultSheetTargetText(kind: SpriteFrameKind, targets: readonly string[]): string {
  return targets.slice(0, 12).map((target) => `${kind}:${target}`).join("\n");
}

function createSpriteReferenceCard(reference: SpriteReferenceImage): HTMLElement {
  const card = document.createElement("article");
  card.className = "sprite-card reference-card";

  const image = document.createElement("img");
  image.alt = reference.name;
  image.src = reference.dataUrl;

  const title = document.createElement("strong");
  title.textContent = reference.name;
  const meta = document.createElement("span");
  meta.textContent = `${reference.mimeType} / ${formatBytes(reference.sizeBytes)}`;

  const actions = document.createElement("div");
  actions.className = "button-row compact-buttons";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => removeSpriteReference(reference.localId));
  actions.append(remove);

  card.append(image, title, meta, actions);
  return card;
}

function createSpriteSheetCard(sheet: SpriteSheetCandidate): HTMLElement {
  const card = document.createElement("article");
  card.className = "sprite-card sprite-sheet-card";

  const image = document.createElement("img");
  image.alt = sheet.name;
  image.src = sheet.dataUrl ?? sheet.url ?? "";

  const title = document.createElement("strong");
  title.textContent = sheet.name;
  const meta = document.createElement("span");
  meta.textContent = [
    "sprite sheet",
    sheet.source,
    sheet.modelId,
    sheet.dataUrl ? "slice-ready" : "review-only",
  ].filter(Boolean).join(" / ");

  const actions = document.createElement("div");
  actions.className = "button-row compact-buttons";
  const slice = document.createElement("button");
  slice.type = "button";
  slice.textContent = "Slice";
  slice.disabled = !sheet.dataUrl;
  slice.addEventListener("click", () => {
    void sliceSpriteSheet(sheet.localId);
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => removeSpriteSheet(sheet.localId));
  actions.append(slice, remove);

  card.append(image, title, meta, actions);
  return card;
}

function createSpriteCard(candidate: SpriteCandidate, approved: boolean): HTMLElement {
  const card = document.createElement("article");
  card.className = "sprite-card";
  card.dataset.approved = String(approved);

  const image = document.createElement("img");
  image.alt = `${candidate.kind} ${candidate.id}`;
  image.src = candidate.dataUrl ?? candidate.url ?? "";

  const title = document.createElement("strong");
  title.textContent = `${candidate.kind}:${candidate.id}`;
  const meta = document.createElement("span");
  meta.textContent = [
    candidate.source,
    candidate.modelId,
    candidate.dataUrl ? "pack-ready" : "review-only",
  ].filter(Boolean).join(" / ");

  const actions = document.createElement("div");
  actions.className = "button-row compact-buttons";
  if (approved) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeApprovedSprite(candidate.kind, candidate.id));
    actions.append(remove);
  } else {
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "Approve";
    approve.disabled = !candidate.dataUrl;
    approve.addEventListener("click", () => approveSpriteCandidate(candidate.localId));
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "secondary";
    reject.textContent = "Reject";
    reject.addEventListener("click", () => rejectSpriteCandidate(candidate.localId));
    actions.append(approve, reject);
  }

  card.append(image, title, meta, actions);
  return card;
}

function createPackResultCard(result: SpritePackResult): HTMLElement {
  const card = document.createElement("article");
  card.className = "sprite-card pack-result";
  const image = document.createElement("img");
  image.alt = "Packed sprite atlas";
  image.src = result.atlasDataUrl;
  const title = document.createElement("strong");
  title.textContent = "Packed atlas";
  const meta = document.createElement("span");
  const manifest = result.manifest as { frames?: unknown[]; atlas?: { width?: number; height?: number } };
  meta.textContent = `${manifest.frames?.length ?? 0} frames / ${manifest.atlas?.width ?? "?"} x ${manifest.atlas?.height ?? "?"}`;
  card.append(image, title, meta);
  return card;
}

async function generateSpriteCandidate(): Promise<void> {
  const output = selectedSpriteOutput();
  const kind = selectedSpriteKind();
  const id = spriteTargetSelect.value;
  const userPrompt = spritePromptInput.value.trim();
  const requestedModelId = spriteModelInput.value.trim();
  if (!userPrompt || !requestedModelId) {
    recordEvent({
      ...activeSessionContext(),
      source: "sprite",
      kind: "sprite.generate.rejected",
      summary: "prompt and model are required",
    });
    return;
  }

  generateSpriteButton.disabled = true;
  try {
    const references = collectSpriteReferenceInputs();
    const mode = resolveSpriteGenerationMode(output, selectedSpriteMode(), references.length);
    const modelId = resolveSpriteModelIdForMode(requestedModelId, mode);
    const prompt = output === "sheet"
      ? buildSpriteSheetPrompt({
        userPrompt,
        kind,
        rows: selectedSpriteSheetGrid().rows,
        cols: selectedSpriteSheetGrid().cols,
        targets: parseSheetFrameTargets(spriteSheetTargetsInput.value),
        usesReferences: references.length > 0,
      })
      : userPrompt;

    if (mode !== selectedSpriteMode()) {
      spriteModeSelect.value = mode;
    }
    if (modelId !== requestedModelId) {
      spriteModelInput.value = modelId;
    }
    if ((mode === "image-to-image" || mode === "edit") && references.length === 0) {
      recordEvent({
        ...activeSessionContext(),
        source: "sprite",
        kind: "sprite.generate.rejected",
        summary: "reference image required",
      });
      return;
    }

    const payload: Record<string, unknown> = {
      mode,
      modelId,
      prompt,
      options: buildSpriteGenerationOptions(output, mode, modelId),
      provenance: {
        label: output === "sheet" ? `${kind}:sprite-sheet` : `${kind}:${id}`,
        source: "host-generated",
      },
    };
    const seed = Number(spriteSeedInput.value);
    if (Number.isFinite(seed)) payload.seed = seed;
    if (mode !== "text-to-image" && references.length === 1) {
      payload.imageUrl = references[0];
    } else if (mode !== "text-to-image" && references.length > 1) {
      payload.imageUrls = references;
    }

    const response = await postJson<{ ok: true; result: {
      modelId: string;
      generatedAt: string;
      prompt: string;
      images: Array<{ url: string; dataUrl?: string; packReady?: boolean; packIssue?: string }>;
    } } | { ok: false; error: { code: string; message: string } }>("/api/sprites/generate", payload);
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    if (output === "sheet") {
      const sheets = response.result.images.map((image, index) => ({
        localId: `generated-sheet:${Date.now()}:${index}`,
        name: `${kind} sheet ${index + 1}`,
        source: "generated" as const,
        dataUrl: image.dataUrl,
        url: image.url,
        prompt: response.result.prompt,
        modelId: response.result.modelId,
        generatedAt: response.result.generatedAt,
      }));
      spriteState.sheets.unshift(...sheets);
    } else {
      const candidates = response.result.images.map((image, index) => ({
        localId: `generated:${Date.now()}:${index}`,
        kind,
        id,
        source: "generated" as const,
        dataUrl: image.dataUrl,
        url: image.url,
        prompt: response.result.prompt,
        modelId: response.result.modelId,
        generatedAt: response.result.generatedAt,
      }));
      spriteState.candidates.unshift(...candidates);
    }
    renderSpriteWorkspace();
    recordEvent({
      ...activeSessionContext(),
      source: "sprite",
      kind: "sprite.generate",
      summary: output === "sheet" ? `${kind}:sprite-sheet` : `${kind}:${id}`,
      payload: {
        modelId: response.result.modelId,
        output,
        referenceCount: references.length,
        promptKind: output === "sheet" ? "sprite-sheet-expanded" : "user",
        imageCount: response.result.images.length,
        packReadyCount: response.result.images.filter((image) => image.packReady || image.dataUrl).length,
      },
    });
  } catch (error) {
    recordEvent({
      ...activeSessionContext(),
      source: "sprite",
      kind: "sprite.generate.failed",
      summary: error instanceof Error ? error.message : "Generation failed",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    generateSpriteButton.disabled = false;
  }
}

async function importSpriteFiles(): Promise<void> {
  const files = [...(spriteImportFile.files ?? [])];
  if (files.length === 0) {
    return;
  }
  const imported: SpriteCandidate[] = [];
  const kind = selectedSpriteKind();
  const id = spriteTargetSelect.value;
  for (const [index, file] of files.entries()) {
    if (!file.type.startsWith("image/")) {
      recordEvent({
        ...activeSessionContext(),
        source: "sprite",
        kind: "sprite.import.rejected",
        summary: `${file.name} is not an image`,
      });
      continue;
    }
    const sourceDataUrl = await readFileAsDataUrl(file);
    imported.push({
      localId: `manual:${Date.now()}:${index}`,
      kind,
      id,
      source: "manual",
      dataUrl: await convertImageDataUrlToPngDataUrl(sourceDataUrl),
    });
  }
  spriteState.candidates.unshift(...imported);
  spriteImportFile.value = "";
  renderSpriteWorkspace();
  recordEvent({
    ...activeSessionContext(),
    source: "sprite",
    kind: "sprite.import",
    summary: `${imported.length} frame images for ${kind}:${id}`,
  });
}

async function importSpriteSheetFiles(): Promise<void> {
  const files = [...(spriteSheetFile.files ?? [])];
  if (files.length === 0) {
    return;
  }
  const imported: SpriteSheetCandidate[] = [];
  for (const [index, file] of files.entries()) {
    if (!file.type.startsWith("image/")) {
      recordEvent({
        ...activeSessionContext(),
        source: "sprite",
        kind: "sprite.sheet.import.rejected",
        summary: `${file.name} is not an image`,
      });
      continue;
    }
    const sourceDataUrl = await readFileAsDataUrl(file);
    imported.push({
      localId: `manual-sheet:${Date.now()}:${index}`,
      name: file.name,
      source: "manual",
      dataUrl: await convertImageDataUrlToPngDataUrl(sourceDataUrl),
    });
  }
  spriteState.sheets.unshift(...imported);
  spriteSheetFile.value = "";
  renderSpriteWorkspace();
  recordEvent({
    ...activeSessionContext(),
    source: "sprite",
    kind: "sprite.sheet.import",
    summary: `${imported.length} sheets`,
  });
}

async function importSpriteReferences(): Promise<void> {
  const files = [...(spriteReferenceFile.files ?? [])];
  if (files.length === 0) {
    return;
  }
  const references: SpriteReferenceImage[] = [];
  for (const [index, file] of files.entries()) {
    if (!file.type.startsWith("image/")) {
      recordEvent({
        ...activeSessionContext(),
        source: "sprite",
        kind: "sprite.reference.rejected",
        summary: `${file.name} is not an image`,
      });
      continue;
    }
    references.push({
      localId: `reference:${Date.now()}:${index}`,
      name: file.name,
      dataUrl: await readFileAsDataUrl(file),
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    });
  }
  spriteState.references.unshift(...references);
  if (references.length > 0) {
    spriteModeSelect.value = "edit";
    spriteModelInput.value = resolveSpriteModelIdForMode(spriteModelInput.value.trim(), "edit");
  }
  spriteReferenceFile.value = "";
  renderSpriteWorkspace();
  recordEvent({
    ...activeSessionContext(),
    source: "sprite",
    kind: "sprite.reference.import",
    summary: `${references.length} references`,
  });
}

function collectSpriteReferenceInputs(): string[] {
  const uploadedReferences = spriteState.references.map((reference) => reference.dataUrl);
  const urlReference = spriteReferenceInput.value.trim();
  return [...uploadedReferences, ...(urlReference ? [urlReference] : [])];
}

function resolveSpriteGenerationMode(
  output: SpriteOutputMode,
  requestedMode: SpriteGenerationMode,
  referenceCount: number,
): SpriteGenerationMode {
  if (referenceCount > 0 && output === "sheet") {
    return "edit";
  }
  if (referenceCount > 0 && requestedMode === "text-to-image") {
    return "edit";
  }
  return requestedMode;
}

function resolveSpriteModelIdForMode(modelId: string, mode: SpriteGenerationMode): string {
  if (mode === "text-to-image" || modelId.endsWith("/edit")) {
    return modelId;
  }
  if (/^fal-ai\/(?:nano-banana|nano-banana-2|gpt-image-1\.5)$/.test(modelId)) {
    return `${modelId}/edit`;
  }
  return modelId;
}

function selectedSpriteSheetGrid(): { rows: number; cols: number } {
  const rows = clampInteger(Number(spriteSheetRowsInput.value), 1, 16);
  const cols = clampInteger(Number(spriteSheetColsInput.value), 1, 16);
  spriteSheetRowsInput.value = String(rows);
  spriteSheetColsInput.value = String(cols);
  return { rows, cols };
}

function buildSpriteGenerationOptions(
  output: SpriteOutputMode,
  mode: SpriteGenerationMode,
  modelId: string,
): Record<string, unknown> {
  if (output !== "sheet") {
    return mode === "text-to-image" ? { output_format: "png", num_images: 1 } : { output_format: "png", num_images: 1 };
  }
  const { rows, cols } = selectedSpriteSheetGrid();
  const aspectRatio = chooseFalAspectRatio(cols, rows);
  const options: Record<string, unknown> = {
    num_images: 1,
    output_format: "png",
    sync_mode: false,
  };
  if (modelId.includes("gpt-image")) {
    return {
      ...options,
      image_size: chooseGptImageSize(cols, rows),
      background: "transparent",
      quality: "high",
      input_fidelity: mode === "text-to-image" ? undefined : "high",
    };
  }
  return {
    ...options,
    aspect_ratio: aspectRatio,
    limit_generations: true,
  };
}

function chooseFalAspectRatio(cols: number, rows: number): string {
  const ratio = cols / rows;
  if (ratio >= 1.75) return "16:9";
  if (ratio >= 1.35) return "4:3";
  if (ratio >= 1.1) return "5:4";
  if (ratio > 0.9) return "1:1";
  if (ratio > 0.72) return "4:5";
  if (ratio > 0.58) return "3:4";
  return "9:16";
}

function chooseGptImageSize(cols: number, rows: number): string {
  const ratio = cols / rows;
  if (ratio > 1.15) return "1536x1024";
  if (ratio < 0.85) return "1024x1536";
  return "1024x1024";
}

function buildSpriteSheetPrompt(input: {
  userPrompt: string;
  kind: SpriteFrameKind;
  rows: number;
  cols: number;
  targets: Array<{ kind: SpriteFrameKind; id: string }>;
  usesReferences: boolean;
}): string {
  const cellCount = input.rows * input.cols;
  const targets = input.targets.length > 0
    ? input.targets.slice(0, cellCount)
    : selectedSpriteTargets().slice(0, cellCount).map((id) => ({ kind: input.kind, id }));
  const targetPlan = targets.map((target, index) => {
    const row = Math.floor(index / input.cols) + 1;
    const col = (index % input.cols) + 1;
    return `row ${row}, column ${col}: ${target.kind}:${target.id}`;
  }).join("; ");
  return [
    `Create ONE single PNG sprite sheet image arranged as an exact ${input.cols} columns by ${input.rows} rows grid (${cellCount} equal cells).`,
    "This must be one complete sheet image, not a single isolated sprite, not separate images, not a collage with uneven panels.",
    "Each cell must have the same avatar centered at the same scale on a transparent background.",
    "Do not add labels, captions, numbers, grid lines, borders, UI chrome, extra characters, or text in the image.",
    input.usesReferences
      ? "Use the uploaded reference image(s) as the identity and style source. Preserve the same character design, silhouette, colors, and rendering style across every cell."
      : "Keep the same character design, silhouette, colors, and rendering style across every cell.",
    `Fill cells in reading order with these targets: ${targetPlan}.`,
    "Only change the expression, mouth, and/or viseme required by each target cell.",
    `Base art direction from the user: ${input.userPrompt}`,
  ].join("\n");
}

function removeSpriteReference(localId: string): void {
  spriteState.references = spriteState.references.filter((reference) => reference.localId !== localId);
  renderSpriteWorkspace();
}

function removeSpriteSheet(localId: string): void {
  spriteState.sheets = spriteState.sheets.filter((sheet) => sheet.localId !== localId);
  renderSpriteWorkspace();
}

async function sliceSpriteSheet(localId: string): Promise<void> {
  const sheet = spriteState.sheets.find((item) => item.localId === localId);
  if (!sheet?.dataUrl) {
    return;
  }
  try {
    const { rows, cols } = selectedSpriteSheetGrid();
    const targets = parseSheetFrameTargets(spriteSheetTargetsInput.value);
    if (targets.length === 0) {
      recordEvent({
        ...activeSessionContext(),
        source: "sprite",
        kind: "sprite.sheet.slice.rejected",
        summary: "sheet targets required",
      });
      return;
    }

    const image = await loadImage(sheet.dataUrl);
    const cellWidth = Math.floor(image.naturalWidth / cols);
    const cellHeight = Math.floor(image.naturalHeight / rows);
    if (cellWidth <= 0 || cellHeight <= 0) {
      throw new Error("Sheet grid is larger than the source image");
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas 2D context is unavailable");
    }
    canvas.width = cellWidth;
    canvas.height = cellHeight;

    const frameCount = Math.min(rows * cols, targets.length);
    const frames: ApprovedSpriteFrame[] = [];
    for (let index = 0; index < frameCount; index += 1) {
      const target = targets[index];
      if (!target) continue;
      const sx = (index % cols) * cellWidth;
      const sy = Math.floor(index / cols) * cellHeight;
      context.clearRect(0, 0, cellWidth, cellHeight);
      context.drawImage(image, sx, sy, cellWidth, cellHeight, 0, 0, cellWidth, cellHeight);
      frames.push({
        kind: target.kind,
        id: target.id,
        dataUrl: canvas.toDataURL("image/png"),
        source: "sheet",
        prompt: sheet.prompt,
        modelId: sheet.modelId,
        generatedAt: sheet.generatedAt,
      });
    }

    upsertApprovedSprites(frames);
    spriteState.lastPack = undefined;
    renderSpriteWorkspace();
    recordEvent({
      ...activeSessionContext(),
      source: "sprite",
      kind: "sprite.sheet.slice",
      summary: `${frames.length} frames`,
      payload: {
        rows,
        cols,
        sheet: sheet.name,
      },
    });
  } catch (error) {
    recordEvent({
      ...activeSessionContext(),
      source: "sprite",
      kind: "sprite.sheet.slice.failed",
      summary: error instanceof Error ? error.message : "Sheet slice failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseSheetFrameTargets(value: string): Array<{ kind: SpriteFrameKind; id: string }> {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => {
      const parts = item.split(":").map((part) => part.trim()).filter(Boolean);
      const maybeKind = parts[0];
      if (maybeKind === "expression" || maybeKind === "viseme") {
        const id = parts.slice(1).join(":").trim();
        return id ? [{ kind: maybeKind, id }] : [];
      }
      return [{ kind: selectedSpriteKind(), id: item }];
    });
}

function upsertApprovedSprites(frames: ApprovedSpriteFrame[]): void {
  const replacementKeys = new Set(frames.map((frame) => `${frame.kind}:${frame.id}`));
  spriteState.approved = [
    ...spriteState.approved.filter((frame) => !replacementKeys.has(`${frame.kind}:${frame.id}`)),
    ...frames,
  ];
}

function approveSpriteCandidate(localId: string): void {
  const candidate = spriteState.candidates.find((item) => item.localId === localId);
  if (!candidate?.dataUrl) {
    return;
  }
  upsertApprovedSprites([{
    kind: candidate.kind,
    id: candidate.id,
    dataUrl: candidate.dataUrl,
    source: candidate.source,
    prompt: candidate.prompt,
    modelId: candidate.modelId,
    generatedAt: candidate.generatedAt,
  }]);
  spriteState.candidates = spriteState.candidates.filter((item) => item.localId !== localId);
  spriteState.lastPack = undefined;
  renderSpriteWorkspace();
  recordEvent({
    ...activeSessionContext(),
    source: "sprite",
    kind: "sprite.approve",
    summary: `${candidate.kind}:${candidate.id}`,
  });
}

function rejectSpriteCandidate(localId: string): void {
  spriteState.candidates = spriteState.candidates.filter((item) => item.localId !== localId);
  renderSpriteWorkspace();
}

function removeApprovedSprite(kind: SpriteCandidate["kind"], id: string): void {
  spriteState.approved = spriteState.approved.filter((frame) => frame.kind !== kind || frame.id !== id);
  spriteState.lastPack = undefined;
  renderSpriteWorkspace();
}

async function packApprovedSprites(): Promise<void> {
  if (spriteState.approved.length === 0) {
    return;
  }
  packSpritesButton.disabled = true;
  try {
    const response = await postJson<{ ok: true; atlasDataUrl: string; manifest: unknown } | { ok: false; error: { message: string } }>(
      "/api/sprites/pack",
      {
        profileId: selectedProfile().id,
        atlasId: `${selectedProfile().id}.sprites`,
        frames: spriteState.approved.map((frame) => ({
          id: frame.id,
          kind: frame.kind,
          dataUrl: frame.dataUrl,
          provenance: {
            label: `${frame.source} ${frame.kind}:${frame.id}`,
            source: frame.source === "manual" ? "user-authored" : "host-generated",
            notes: [frame.modelId, frame.generatedAt].filter(Boolean).join(" / ") || undefined,
          },
        })),
      },
    );
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    spriteState.lastPack = {
      atlasDataUrl: response.atlasDataUrl,
      manifest: response.manifest,
    };
    downloadDataUrl(`device-studio-${selectedProfile().id}-sprites.png`, response.atlasDataUrl);
    downloadText(
      `device-studio-${selectedProfile().id}-sprites.manifest.json`,
      `${JSON.stringify(response.manifest, null, 2)}\n`,
      "application/json",
    );
    renderSpriteWorkspace();
    recordEvent({
      ...activeSessionContext(),
      source: "sprite",
      kind: "sprite.pack",
      summary: `${spriteState.approved.length} frames`,
      payload: {
        profileId: selectedProfile().id,
        frameCount: spriteState.approved.length,
      },
    });
  } catch (error) {
    recordEvent({
      ...activeSessionContext(),
      source: "sprite",
      kind: "sprite.pack.failed",
      summary: error instanceof Error ? error.message : "Pack failed",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    packSpritesButton.disabled = false;
  }
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const parsed = await response.json() as T;
  if (!response.ok && typeof parsed === "object" && parsed !== null && "error" in parsed) {
    return parsed;
  }
  return parsed;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("File did not produce a data URL"));
      }
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("File read failed")));
    reader.readAsDataURL(file);
  });
}

async function convertImageDataUrlToPngDataUrl(dataUrl: string): Promise<string> {
  if (dataUrl.startsWith("data:image/png;")) {
    return dataUrl;
  }
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is unavailable");
  }
  context.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("Image could not be loaded")), { once: true });
    image.src = dataUrl;
  });
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown size";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadDataUrl(filename: string, dataUrl: string): void {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

async function copyEventLog(): Promise<void> {
  const text = formatDeviceStudioEventForClipboard(operationalLog.entries);
  try {
    await navigator.clipboard.writeText(text);
    recordEvent({
      ...activeSessionContext(),
      source: "import/export",
      kind: "event-log.copy",
      summary: `${operationalLog.entries.length} entries`,
    });
  } catch (error) {
    recordEvent({
      ...activeSessionContext(),
      source: "import/export",
      kind: "event-log.copy.failed",
      summary: error instanceof Error ? error.message : "Copy failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function exportEventLog(): void {
  downloadText("device-studio-event-log.json", operationalLog.toJson(), "application/json");
  recordEvent({
    ...activeSessionContext(),
    source: "import/export",
    kind: "event-log.export",
    summary: `${operationalLog.entries.length} entries`,
  });
}

function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

renderProfileOptions();

profileSelect.addEventListener("change", () => {
  stopActivePlayback("profile changed");
  state.profileId = profileSelect.value;
  state.selectedFrameIndex = 0;
  state.elapsedMs = 0;
  replaceHubClient();
  ensureSelectedBehavior();
  render();
  recordEvent({
    ...activeSessionContext(),
    source: "user",
    kind: "profile.select",
    summary: selectedProfile().name,
    payload: {
      profileId: state.profileId,
      touch: selectedProfile().touch,
    },
  });
  recordHardwareVerification("profile");
});

document.querySelectorAll<HTMLInputElement>('input[name="backend-mode"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked) {
      return;
    }
    state.backendMode = input.value as DeviceStudioTransportMode;
    replaceHubClient();
    render();
    recordEvent({
      ...activeSessionContext(),
      source: "user",
      kind: "backend.mode",
      summary: state.backendMode,
    });
  });
});

hubUrl.addEventListener("change", () => replaceHubClient());

connectButton.addEventListener("click", () => {
  void toggleConnection();
});

pingButton.addEventListener("click", () => {
  ensureHubClient().ping();
});

interruptButton.addEventListener("click", () => {
  stopActivePlayback("interrupt");
  ensureHubClient().interrupt();
});

sendCommandButton.addEventListener("click", () => {
  void sendTypedTurn();
});

draftCommandButton.addEventListener("click", () => createDraftCommand());

importBehaviorButton.addEventListener("click", () => importBehaviorFile.click());

importBehaviorFile.addEventListener("change", () => {
  void importBehaviorFileSelection();
});

exportBehaviorButton.addEventListener("click", () => exportSelectedBehavior());

newBehaviorButton.addEventListener("click", () => createNewBehavior());

duplicateBehaviorButton.addEventListener("click", () => duplicateSelectedBehavior());

deleteBehaviorButton.addEventListener("click", () => deleteSelectedBehavior());

behaviorNameInput.addEventListener("change", () => updateSelectedBehaviorName());

frameSelect.addEventListener("change", () => selectFrame(Number(frameSelect.value)));

addFrameButton.addEventListener("click", () => addBehaviorFrame());

duplicateFrameButton.addEventListener("click", () => duplicateBehaviorFrame());

deleteFrameButton.addEventListener("click", () => deleteBehaviorFrame());

frameTimeInput.addEventListener("change", () => updateFrameTiming());
frameDurationInput.addEventListener("change", () => updateFrameTiming());
frameLabelInput.addEventListener("change", () => updateFrameTiming());

expressionIdSelect.addEventListener("change", () => updateFrameExpression());
expressionEyesSelect.addEventListener("change", () => updateFrameExpression());
expressionMouthSelect.addEventListener("change", () => updateFrameExpression());
expressionIntensityInput.addEventListener("input", () => updateFrameExpression());

visemeIdSelect.addEventListener("change", () => updateFrameViseme());
visemeWeightInput.addEventListener("input", () => updateFrameViseme());

displayModeSelect.addEventListener("change", () => updateFrameDisplay());
displayBackgroundInput.addEventListener("input", () => updateFrameDisplay());
displayTextInput.addEventListener("change", () => updateFrameDisplay());
backlightInput.addEventListener("input", () => updateFrameBacklight());

playButton.addEventListener("click", () => playSelectedBehavior());

stopButton.addEventListener("click", () => stopActivePlayback("user stop"));

copyLogButton.addEventListener("click", () => {
  void copyEventLog();
});

exportLogButton.addEventListener("click", () => exportEventLog());

spriteOutputSelect.addEventListener("change", () => {
  if (selectedSpriteOutput() === "sheet" && collectSpriteReferenceInputs().length > 0) {
    spriteModeSelect.value = "edit";
    spriteModelInput.value = resolveSpriteModelIdForMode(spriteModelInput.value.trim(), "edit");
  }
  renderSpriteWorkspace();
});
spriteKindSelect.addEventListener("change", () => renderSpriteWorkspace());

generateSpriteButton.addEventListener("click", () => {
  void generateSpriteCandidate();
});

importSpriteButton.addEventListener("click", () => spriteImportFile.click());

importSpriteSheetButton.addEventListener("click", () => spriteSheetFile.click());

uploadSpriteReferenceButton.addEventListener("click", () => spriteReferenceFile.click());

clearSpriteReferencesButton.addEventListener("click", () => {
  spriteState.references = [];
  renderSpriteWorkspace();
});

spriteReferenceFile.addEventListener("change", () => {
  void importSpriteReferences();
});

spriteImportFile.addEventListener("change", () => {
  void importSpriteFiles();
});

spriteSheetFile.addEventListener("change", () => {
  void importSpriteSheetFiles();
});

packSpritesButton.addEventListener("click", () => {
  void packApprovedSprites();
});

replaceHubClient();
render();
recordEvent({
  ...activeSessionContext(),
  source: "transport",
  kind: "studio.ready",
  summary: "Device Studio initialized",
  payload: {
    profileId: state.profileId,
    behaviorId: state.selectedBehaviorId,
  },
});
