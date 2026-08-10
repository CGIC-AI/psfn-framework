import type { NormalizedBehaviorRenderState } from "../device-studio/behavior.js";
import type {
  DeviceProfile,
  DisplayShape,
  ExpressionState,
  IgnoredBehaviorChannel,
  VisemeState,
} from "../device-studio/model.js";

export type AvatarEyeShape = "open" | "closed" | "squint" | "wink" | "wide";
export type AvatarMouthShape = "neutral" | "smile" | "laugh" | "frown" | "open" | "sing" | "closed";
export type DisplayClip = "inset" | "circle";
export type DisplayTouchGesture = "tap" | "double-tap" | "long-press" | "swipe" | "drag";

export interface DisplayBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DisplayPointerInput {
  clientX: number;
  clientY: number;
  pointerId?: number;
  pointerType?: string;
}

export interface DisplayTouchPoint {
  normalized: {
    x: number;
    y: number;
  };
  pixel: {
    x: number;
    y: number;
  };
}

export interface DisplayTouchLogDetail {
  schemaVersion: 1;
  type: "display.touch";
  profileId: string;
  profileName: string;
  gesture: DisplayTouchGesture;
  display: {
    width: number;
    height: number;
    shape: DisplayShape;
  };
  normalized: {
    x: number;
    y: number;
  };
  pixel: {
    x: number;
    y: number;
  };
  start: DisplayTouchPoint;
  delta: {
    normalizedX: number;
    normalizedY: number;
    pixelX: number;
    pixelY: number;
  };
  durationMs: number;
  pointer: {
    id?: number;
    type: string;
  };
  supportedGestures: DisplayTouchGesture[];
}

export interface DisplayPreviewSnapshot {
  profileId: string;
  profileName: string;
  display: {
    width: number;
    height: number;
    shape: DisplayShape;
    aspectRatio: string;
    clip: DisplayClip;
  };
  touch: {
    enabled: boolean;
    points: number;
    gestures: DisplayTouchGesture[];
    label: string;
  };
  expression: {
    id: string;
    label: string;
    intensity: number;
    eyes: AvatarEyeShape;
    mouth: AvatarMouthShape;
  };
  viseme: {
    id: string;
    label: string;
    weight: number;
  };
  channels: {
    compatible: boolean;
    supported: string[];
    ignored: IgnoredBehaviorChannel[];
    ignoredLabel: string;
  };
  displayMode: "face" | "image" | "text" | "clear";
  displayText: string;
  frameLabel: string;
  backgroundColor: string;
  backlightBrightness: number;
}

interface DisplayPreviewOptions {
  onTouch?: (detail: DisplayTouchLogDetail) => void;
  now?: () => number;
}

interface PointerStart {
  atMs: number;
  point: DisplayTouchPoint;
  pointerId?: number;
  pointerType: string;
}

const DEFAULT_BACKGROUND = "#101918";
const DOUBLE_TAP_MS = 340;
const LONG_PRESS_MS = 550;
const MOVE_GESTURE_PX = 18;

export class DisplayPreview {
  private readonly root: HTMLElement;
  private readonly options: DisplayPreviewOptions;
  private readonly device = createElement("div", "lcd-device");
  private readonly bezel = createElement("div", "lcd-bezel");
  private readonly surface = createElement("div", "lcd-surface");
  private readonly face = createElement("div", "lcd-face-2d");
  private readonly leftEye = createElement("div", "lcd-eye lcd-eye-left");
  private readonly rightEye = createElement("div", "lcd-eye lcd-eye-right");
  private readonly mouth = createElement("div", "lcd-mouth");
  private readonly displayText = createElement("div", "lcd-display-text");
  private readonly statePanel = createElement("aside", "preview-state");
  private readonly expressionValue = createDefinitionValue("Expression");
  private readonly visemeValue = createDefinitionValue("Viseme");
  private readonly touchValue = createDefinitionValue("Touch");
  private readonly channelsValue = createDefinitionValue("Channels");
  private profile: DeviceProfile | undefined;
  private renderState: NormalizedBehaviorRenderState | undefined;
  private pointerStart: PointerStart | undefined;
  private lastTapAtMs = Number.NEGATIVE_INFINITY;

  constructor(root: HTMLElement, options: DisplayPreviewOptions = {}) {
    this.root = root;
    this.options = options;

    this.surface.setAttribute("role", "img");
    this.surface.tabIndex = 0;
    this.face.append(this.leftEye, this.rightEye, this.mouth);
    this.surface.append(this.face, this.displayText);
    this.bezel.append(this.surface);
    this.device.append(this.bezel);
    this.statePanel.setAttribute("aria-label", "Preview state");
    this.statePanel.append(createDefinitionList([
      this.expressionValue,
      this.visemeValue,
      this.touchValue,
      this.channelsValue,
    ]));
    this.root.replaceChildren(this.device);

    this.surface.addEventListener("pointerdown", this.handlePointerDown);
    this.surface.addEventListener("pointerup", this.handlePointerUp);
    this.surface.addEventListener("pointercancel", this.handlePointerCancel);
  }

  setProfile(profile: DeviceProfile): void {
    this.profile = profile;
    this.render(this.renderState);
  }

  render(renderState?: NormalizedBehaviorRenderState): void {
    this.renderState = renderState;
    if (!this.profile) {
      return;
    }

    const snapshot = createDisplayPreviewSnapshot(this.profile, renderState);
    this.root.dataset.profile = snapshot.profileId;
    this.root.dataset.shape = snapshot.display.shape;
    this.root.dataset.touch = String(snapshot.touch.enabled);
    this.root.dataset.compatible = String(snapshot.channels.compatible);
    this.root.dataset.ignoredChannels = String(snapshot.channels.ignored.length > 0);
    this.bezel.style.setProperty("--display-aspect", snapshot.display.aspectRatio);
    this.surface.style.setProperty("--lcd-bg", snapshot.backgroundColor);
    this.surface.style.setProperty("--lcd-brightness", formatCssNumber(snapshot.backlightBrightness));
    this.surface.setAttribute(
      "aria-label",
      `${snapshot.profileName} ${snapshot.display.width} by ${snapshot.display.height} LCD avatar preview`,
    );
    this.surface.dataset.mode = snapshot.displayMode;
    this.face.dataset.eyes = snapshot.expression.eyes;
    this.face.dataset.mouth = snapshot.expression.mouth;
    this.face.style.setProperty("--face-opacity", formatCssNumber(0.55 + (snapshot.expression.intensity * 0.45)));
    this.displayText.textContent = snapshot.displayText;
    this.displayText.hidden = snapshot.displayText.length === 0;
    this.face.hidden = snapshot.displayMode === "clear";
    this.expressionValue.value.textContent = snapshot.expression.label;
    this.visemeValue.value.textContent = snapshot.viseme.label;
    this.touchValue.value.textContent = snapshot.touch.label;
    this.channelsValue.value.textContent = snapshot.channels.ignoredLabel;
  }

  destroy(): void {
    this.surface.removeEventListener("pointerdown", this.handlePointerDown);
    this.surface.removeEventListener("pointerup", this.handlePointerUp);
    this.surface.removeEventListener("pointercancel", this.handlePointerCancel);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.profile?.touch.supported) {
      return;
    }

    const point = mapPointerToDisplayTouch(this.profile, this.surface.getBoundingClientRect(), event);
    if (!point) {
      return;
    }

    this.pointerStart = {
      atMs: this.currentTime(),
      point,
      pointerId: event.pointerId,
      pointerType: event.pointerType || "pointer",
    };
    this.surface.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const profile = this.profile;
    const start = this.pointerStart;
    if (!profile?.touch.supported || !start || start.pointerId !== event.pointerId) {
      return;
    }

    this.pointerStart = undefined;
    const end = mapPointerToDisplayTouch(profile, this.surface.getBoundingClientRect(), event);
    if (!end) {
      return;
    }

    const now = this.currentTime();
    const durationMs = Math.max(0, now - start.atMs);
    const delta = {
      normalizedX: roundForLog(end.normalized.x - start.point.normalized.x),
      normalizedY: roundForLog(end.normalized.y - start.point.normalized.y),
      pixelX: end.pixel.x - start.point.pixel.x,
      pixelY: end.pixel.y - start.point.pixel.y,
    };
    const gesture = resolveGesture(profile, durationMs, delta, now - this.lastTapAtMs);
    this.lastTapAtMs = now;
    this.options.onTouch?.({
      schemaVersion: 1,
      type: "display.touch",
      profileId: profile.id,
      profileName: profile.name,
      gesture,
      display: {
        width: profile.display.width,
        height: profile.display.height,
        shape: profile.display.shape,
      },
      normalized: end.normalized,
      pixel: end.pixel,
      start: start.point,
      delta,
      durationMs: Math.round(durationMs),
      pointer: {
        id: event.pointerId,
        type: event.pointerType || start.pointerType,
      },
      supportedGestures: normalizeGestures(profile.touch.gestures),
    });
    event.preventDefault();
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (this.pointerStart?.pointerId === event.pointerId) {
      this.pointerStart = undefined;
    }
  };

  private currentTime(): number {
    return this.options.now?.() ?? performance.now();
  }
}

export function createDisplayPreviewSnapshot(
  profile: DeviceProfile,
  renderState?: NormalizedBehaviorRenderState,
): DisplayPreviewSnapshot {
  const expression = renderState?.expression;
  const viseme = renderState?.viseme;
  const displayMode = renderState?.display?.mode ?? "face";
  const displayText = resolveDisplayText(renderState);
  const backlightBrightness = clampUnit(renderState?.backlight?.brightness ?? 0.82);
  const ignored = renderState?.ignoredChannels ?? [];

  return {
    profileId: profile.id,
    profileName: profile.name,
    display: {
      width: profile.display.width,
      height: profile.display.height,
      shape: profile.display.shape,
      aspectRatio: reduceRatio(profile.display.width, profile.display.height),
      clip: profile.display.shape === "round" ? "circle" : "inset",
    },
    touch: {
      enabled: profile.touch.supported,
      points: profile.touch.points ?? 0,
      gestures: normalizeGestures(profile.touch.gestures),
      label: formatTouchLabel(profile),
    },
    expression: {
      id: expression?.id ?? "neutral",
      label: formatExpressionLabel(expression),
      intensity: clampUnit(expression?.intensity ?? 1),
      eyes: resolveEyes(expression),
      mouth: resolveMouth(expression, viseme),
    },
    viseme: {
      id: viseme?.id ?? "rest",
      label: formatVisemeLabel(viseme),
      weight: clampUnit(viseme?.weight ?? 1),
    },
    channels: {
      compatible: renderState?.compatible ?? true,
      supported: renderState?.supportedChannels ?? [],
      ignored,
      ignoredLabel: formatIgnoredChannels(ignored),
    },
    displayMode,
    displayText,
    frameLabel: renderState?.activeFrame?.label ?? "No frame",
    backgroundColor: renderState?.display?.backgroundColor ?? DEFAULT_BACKGROUND,
    backlightBrightness,
  };
}

export function formatProfilePreviewMeta(profile: DeviceProfile): string {
  return [
    `${profile.display.width} x ${profile.display.height}`,
    profile.display.shape,
    formatTouchLabel(profile).toLowerCase(),
  ].join(" / ");
}

export function mapPointerToDisplayTouch(
  profile: DeviceProfile,
  bounds: DisplayBounds,
  input: DisplayPointerInput,
): DisplayTouchPoint | undefined {
  if (!profile.touch.supported || bounds.width <= 0 || bounds.height <= 0) {
    return undefined;
  }

  const rawX = (input.clientX - bounds.left) / bounds.width;
  const rawY = (input.clientY - bounds.top) / bounds.height;
  if (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1) {
    return undefined;
  }
  if (profile.display.shape === "round" && !insideRoundClip(rawX, rawY)) {
    return undefined;
  }

  const normalized = {
    x: roundForLog(rawX),
    y: roundForLog(rawY),
  };
  return {
    normalized,
    pixel: {
      x: normalizedToPixel(rawX, profile.display.width),
      y: normalizedToPixel(rawY, profile.display.height),
    },
  };
}

export function formatIgnoredChannels(ignored: IgnoredBehaviorChannel[]): string {
  if (ignored.length === 0) {
    return "All active";
  }
  return ignored
    .map((channel) => channel.targetId ? `${channel.channel}:${channel.targetId}` : channel.channel)
    .join(", ");
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  return element;
}

function createDefinitionValue(label: string): { container: HTMLDivElement; value: HTMLElement } {
  const container = createElement("div");
  const term = createElement("dt");
  const value = createElement("dd");
  term.textContent = label;
  container.append(term, value);
  return { container, value };
}

function createDefinitionList(values: Array<{ container: HTMLDivElement }>): HTMLDListElement {
  const list = createElement("dl");
  list.append(...values.map((value) => value.container));
  return list;
}

function reduceRatio(width: number, height: number): string {
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor} / ${height / divisor}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.round(left));
  let b = Math.abs(Math.round(right));
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function resolveEyes(expression?: ExpressionState): AvatarEyeShape {
  if (expression?.eyes) {
    return expression.eyes;
  }
  switch (expression?.id) {
    case "angry":
      return "squint";
    case "blink":
    case "sleepy":
      return "closed";
    case "surprised":
      return "wide";
    default:
      return "open";
  }
}

function resolveMouth(expression?: ExpressionState, viseme?: VisemeState): AvatarMouthShape {
  const visemeMouth = visemeToMouth(viseme);
  if (visemeMouth && clampUnit(viseme?.weight ?? 0) >= 0.55) {
    return visemeMouth;
  }
  return expression?.mouth ?? inferMouthFromExpressionId(expression?.id);
}

function visemeToMouth(viseme?: VisemeState): AvatarMouthShape | undefined {
  switch ((viseme?.id ?? "").toLowerCase()) {
    case "m":
    case "closed":
    case "sil":
    case "rest":
      return "closed";
    case "a":
    case "aa":
    case "wide":
      return "open";
    case "e":
    case "ee":
    case "i":
      return "smile";
    case "o":
    case "oh":
    case "u":
      return "sing";
    default:
      return undefined;
  }
}

function inferMouthFromExpressionId(id?: string): AvatarMouthShape {
  switch (id) {
    case "happy":
      return "smile";
    case "laughing":
      return "laugh";
    case "angry":
    case "sad":
      return "frown";
    case "surprised":
      return "open";
    case "singing":
      return "sing";
    default:
      return "neutral";
  }
}

function resolveDisplayText(renderState?: NormalizedBehaviorRenderState): string {
  const display = renderState?.display;
  if (!display) {
    return "";
  }
  if (display.mode === "text") {
    return display.text ?? "";
  }
  if (display.mode === "image") {
    return display.assetId ? `Image ${display.assetId}` : "Image";
  }
  return "";
}

function formatExpressionLabel(expression?: ExpressionState): string {
  if (!expression) {
    return "Neutral";
  }
  const intensity = expression.intensity === undefined ? "" : ` ${Math.round(clampUnit(expression.intensity) * 100)}%`;
  return `${titleCase(expression.id)}${intensity}`;
}

function formatVisemeLabel(viseme?: VisemeState): string {
  if (!viseme) {
    return "Rest";
  }
  const weight = viseme.weight === undefined ? "" : ` ${Math.round(clampUnit(viseme.weight) * 100)}%`;
  return `${titleCase(viseme.id)}${weight}`;
}

function formatTouchLabel(profile: DeviceProfile): string {
  if (!profile.touch.supported) {
    return "No touch";
  }
  const points = profile.touch.points ?? 1;
  return `Touch ${points} pt${points === 1 ? "" : "s"}`;
}

function normalizeGestures(gestures: DeviceProfile["touch"]["gestures"]): DisplayTouchGesture[] {
  return (gestures ?? ["tap"]).filter(isDisplayTouchGesture);
}

function isDisplayTouchGesture(value: string): value is DisplayTouchGesture {
  return value === "tap"
    || value === "double-tap"
    || value === "long-press"
    || value === "swipe"
    || value === "drag";
}

function resolveGesture(
  profile: DeviceProfile,
  durationMs: number,
  delta: DisplayTouchLogDetail["delta"],
  sinceLastTapMs: number,
): DisplayTouchGesture {
  const gestures = new Set(normalizeGestures(profile.touch.gestures));
  const distancePx = Math.hypot(delta.pixelX, delta.pixelY);
  if (distancePx >= MOVE_GESTURE_PX) {
    if (gestures.has("swipe")) return "swipe";
    if (gestures.has("drag")) return "drag";
  }
  if (durationMs >= LONG_PRESS_MS && gestures.has("long-press")) {
    return "long-press";
  }
  if (sinceLastTapMs <= DOUBLE_TAP_MS && gestures.has("double-tap")) {
    return "double-tap";
  }
  return "tap";
}

function insideRoundClip(x: number, y: number): boolean {
  return Math.hypot(x - 0.5, y - 0.5) <= 0.5;
}

function normalizedToPixel(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, Math.round(value * (size - 1))));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function roundForLog(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatCssNumber(value: number): string {
  return String(roundForLog(value));
}

function titleCase(value: string): string {
  return value
    .split(/[-_.\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
