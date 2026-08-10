import type {
  DeviceProfile,
  HardwareVerification,
  Provenance,
} from "./model.js";

export type ConcreteDeviceFamily = "stackchan" | "round-lcd";

export interface AudioIoSpec {
  microphone: boolean;
  speaker: boolean;
  hardwareVerification: HardwareVerification;
  notes: string;
}

export interface FaceChannelSpec {
  renderer: "stackchan-face" | "round-lcd-face";
  expressions: string[];
  visemes: string[];
}

export interface RendererHints {
  preferredRenderer: "stackchan-pose" | "round-lcd-2d";
  displayClip: "rectangular" | "round";
  movementPreview: "pan-tilt" | "none";
}

export interface HubHelloCapabilities {
  input: string[];
  output: string[];
  control: string[];
  safety: string[];
}

export interface ConcreteDeviceProfile extends DeviceProfile {
  version: string;
  description: string;
  family: ConcreteDeviceFamily;
  audio: AudioIoSpec;
  face: FaceChannelSpec;
  rendererHints: RendererHints;
  helloCapabilities: HubHelloCapabilities;
  sourceNotes: string[];
}

const STACKCHAN_SOURCE_URL = "https://docs.m5stack.com/en/stackchan";
const WAVESHARE_ROUND_LCD_SOURCE_URL = "https://www.waveshare.com/wiki/ESP32-S3-Touch-LCD-1.85";

const STACKCHAN_PROVENANCE: Provenance = {
  label: "M5Stack StackChan source notes with host-side Device Studio ranges",
  source: "host-generated",
  url: STACKCHAN_SOURCE_URL,
  notes: [
    "Feature list is derived from M5Stack StackChan documentation.",
    "Semantic movement limits are host-side simulator assumptions pending bench calibration.",
  ].join(" "),
};

const WAVESHARE_ROUND_LCD_PROVENANCE: Provenance = {
  label: "Waveshare ESP32-S3 Touch LCD 1.85 source notes",
  source: "host-generated",
  url: WAVESHARE_ROUND_LCD_SOURCE_URL,
  notes: [
    "Display and touch variant metadata is derived from Waveshare documentation.",
    "This screen-centric profile intentionally advertises no servos, LEDs, microphone, or speaker.",
  ].join(" "),
};

const UNVERIFIED_PROFILE: HardwareVerification = {
  status: "unverified",
  label: "Not verified in PSFN Device Studio hardware intake",
  notes: "Profile validates as host data, but no physical device has accepted these settings in this repo.",
};

const UNVERIFIED_SERVO_RANGE: HardwareVerification = {
  status: "unverified",
  label: "Host-side movement range assumption",
  notes: "Use only for simulator preview until a physical unit measures safe center-relative limits.",
};

const UNVERIFIED_SCREEN_CONTROL: HardwareVerification = {
  status: "unverified",
  label: "Display control not verified on PSFN firmware",
  notes: "Backlight/display control is modeled for Device Studio and still needs firmware intake.",
};

const UNVERIFIED_AUDIO_IO: HardwareVerification = {
  status: "unverified",
  label: "Audio path not verified on PSFN firmware",
  notes: "Hardware capability is documented, but microphone/speaker use has not been measured in this repo.",
};

export const stackChanProfile: ConcreteDeviceProfile = {
  id: "stackchan.m5stack.cores3.reference",
  name: "M5Stack Stack-chan Reference",
  version: "0.1.0",
  description: "Stack-chan-style companion profile with face screen, touch, audio I/O, RGB status LEDs, and two semantic head motion channels.",
  family: "stackchan",
  formFactor: "stackchan-style",
  display: {
    width: 320,
    height: 240,
    shape: "rectangular",
    colorDepth: 16,
    safeArea: {
      x: 0,
      y: 0,
      width: 320,
      height: 240,
    },
  },
  touch: {
    supported: true,
    points: 2,
    gestures: ["tap", "double-tap", "long-press", "swipe", "drag"],
  },
  capabilities: {
    input: ["text", "audio", "touch", "gesture"],
    output: ["display", "expression", "viseme", "speech", "audio", "motion", "led", "backlight"],
    control: ["interrupt", "behavior-playback", "profile-select", "brightness", "volume"],
  },
  joints: [
    {
      id: "head.yaw",
      name: "Head yaw",
      axis: "yaw",
      unit: "degrees",
      min: -90,
      max: 90,
      neutral: 0,
      hardwareVerification: UNVERIFIED_SERVO_RANGE,
    },
    {
      id: "head.pitch",
      name: "Head pitch",
      axis: "pitch",
      unit: "degrees",
      min: -40,
      max: 40,
      neutral: 0,
      hardwareVerification: UNVERIFIED_SERVO_RANGE,
    },
  ],
  leds: [
    {
      id: "status.rgb",
      name: "Body RGB LED rows",
      kind: "rgb",
      count: 12,
      hardwareVerification: UNVERIFIED_PROFILE,
    },
  ],
  backlight: {
    supported: true,
    min: 0,
    max: 1,
    hardwareVerification: UNVERIFIED_SCREEN_CONTROL,
  },
  provenance: STACKCHAN_PROVENANCE,
  hardwareVerification: UNVERIFIED_PROFILE,
  audio: {
    microphone: true,
    speaker: true,
    hardwareVerification: UNVERIFIED_AUDIO_IO,
    notes: "M5Stack documents dual microphones and a 1W speaker; Device Studio has not verified the audio route.",
  },
  face: {
    renderer: "stackchan-face",
    expressions: ["neutral", "happy", "laughing", "angry", "sad", "surprised", "sleepy", "blink"],
    visemes: ["rest", "closed", "a", "e", "i", "o", "u", "m", "wide"],
  },
  rendererHints: {
    preferredRenderer: "stackchan-pose",
    displayClip: "rectangular",
    movementPreview: "pan-tilt",
  },
  helloCapabilities: {
    input: ["text", "wake_event", "audio", "touch"],
    output: ["text", "subtitle", "expression", "viseme", "gaze", "servo", "led", "animation", "action", "streamed_audio"],
    control: ["interrupt", "presence", "session_attach"],
    safety: ["local_only", "simulator_profile"],
  },
  sourceNotes: [
    "M5Stack StackChan documentation lists a 2.0-inch 320x240 capacitive touch display, dual microphones, 1W speaker, two feedback servos, and 12 RGB LEDs.",
    "Servo channels are Device Studio semantic head.yaw/head.pitch ranges; they are not firmware pin assignments or hardware-safe travel limits.",
    "The yaw channel is constrained for preview despite the documented continuous horizontal servo; bench intake should replace this range.",
  ],
};

export const waveshareEsp32S3RoundTouchProfile: ConcreteDeviceProfile = {
  id: "waveshare.esp32-s3-touch-lcd-1.85",
  name: "Waveshare ESP32-S3 Touch LCD 1.85",
  version: "0.1.0",
  description: "Screen-centric 1.85-inch round LCD profile for the touch-capable Waveshare ESP32-S3 board variant.",
  family: "round-lcd",
  formFactor: "round-lcd",
  display: {
    width: 360,
    height: 360,
    shape: "round",
    colorDepth: 18,
    safeArea: {
      x: 0,
      y: 0,
      width: 360,
      height: 360,
    },
  },
  touch: {
    supported: true,
    points: 1,
    gestures: ["tap", "long-press", "swipe", "drag"],
  },
  capabilities: {
    input: ["text", "touch"],
    output: ["display", "expression", "viseme", "backlight"],
    control: ["interrupt", "behavior-playback", "profile-select", "brightness"],
  },
  joints: [],
  leds: [],
  backlight: {
    supported: true,
    min: 0,
    max: 1,
    hardwareVerification: UNVERIFIED_SCREEN_CONTROL,
  },
  provenance: WAVESHARE_ROUND_LCD_PROVENANCE,
  hardwareVerification: UNVERIFIED_PROFILE,
  audio: {
    microphone: false,
    speaker: false,
    hardwareVerification: UNVERIFIED_PROFILE,
    notes: "Audio is not advertised by this Studio profile until the exact board SKU and satellite audio path are verified.",
  },
  face: {
    renderer: "round-lcd-face",
    expressions: ["neutral", "happy", "laughing", "angry", "sad", "surprised", "sleepy", "blink"],
    visemes: ["rest", "closed", "a", "e", "i", "o", "u", "m", "wide"],
  },
  rendererHints: {
    preferredRenderer: "round-lcd-2d",
    displayClip: "round",
    movementPreview: "none",
  },
  helloCapabilities: {
    input: ["text", "touch"],
    output: ["text", "subtitle", "expression", "viseme", "display", "backlight", "animation"],
    control: ["interrupt", "presence", "session_attach"],
    safety: ["local_only", "screen_centric"],
  },
  sourceNotes: [
    "Waveshare documents ESP32-S3-Touch-LCD-1.85 as the touch version of its 1.85-inch round 360x360 LCD board.",
    "Motion and LED channels are intentionally absent so Stack-chan behavior degrades to screen, expression, viseme, and backlight output.",
    "Audio-related hardware mentioned by Waveshare is not part of this screen-centric profile until hardware intake confirms the target SKU and firmware route.",
  ],
};

export const concreteDeviceProfileFixtures: ConcreteDeviceProfile[] = [
  stackChanProfile,
  waveshareEsp32S3RoundTouchProfile,
];

export const concreteDeviceProfiles = concreteDeviceProfileFixtures;

export function getConcreteDeviceProfile(id: string): ConcreteDeviceProfile | undefined {
  return concreteDeviceProfileFixtures.find((profile) => profile.id === id);
}

