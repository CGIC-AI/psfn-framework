import type {
  BehaviorTimeline,
  DeviceProfile,
  HardwareVerification,
  Provenance,
} from "./model.js";

const HOST_GENERATED_FIXTURE: Provenance = {
  label: "Host-generated Device Studio fixture",
  source: "test-fixture",
  notes: "Synthetic data for model, preview, and degradation tests; not vendor calibration data.",
};

const OFFICIAL_REFERENCE_SHAPE: Provenance = {
  label: "Official-style profile schema example",
  source: "host-generated",
  notes: "Representative profile shape only; concrete hardware profiles are owned by profile fixture tasks.",
};

const UNVERIFIED_HARDWARE: HardwareVerification = {
  status: "unverified",
  label: "Not verified on physical hardware",
};

const SIMULATED_ONLY: HardwareVerification = {
  status: "simulated-only",
  label: "Simulated behavior; hardware safety has not been measured",
};

export const fixtureMotionDisplayProfile: DeviceProfile = {
  id: "fixture.motion-display",
  name: "Fixture Motion Display Device",
  formFactor: "stackchan-style",
  display: {
    width: 240,
    height: 240,
    shape: "square",
    colorDepth: 16,
  },
  touch: {
    supported: true,
    points: 1,
    gestures: ["tap", "long-press"],
  },
  capabilities: {
    input: ["text", "audio", "touch"],
    output: ["display", "expression", "viseme", "speech", "motion", "led", "backlight"],
    control: ["interrupt", "behavior-playback", "brightness", "volume"],
  },
  joints: [
    {
      id: "head.yaw",
      name: "Head yaw",
      axis: "yaw",
      unit: "degrees",
      min: -35,
      max: 35,
      neutral: 0,
      hardwareVerification: UNVERIFIED_HARDWARE,
    },
    {
      id: "head.pitch",
      name: "Head pitch",
      axis: "pitch",
      unit: "degrees",
      min: -20,
      max: 25,
      neutral: 0,
      hardwareVerification: UNVERIFIED_HARDWARE,
    },
  ],
  leds: [
    {
      id: "status.rgb",
      name: "Status RGB LED",
      kind: "rgb",
      count: 1,
      hardwareVerification: UNVERIFIED_HARDWARE,
    },
  ],
  backlight: {
    supported: true,
    min: 0,
    max: 1,
    hardwareVerification: UNVERIFIED_HARDWARE,
  },
  provenance: OFFICIAL_REFERENCE_SHAPE,
  hardwareVerification: UNVERIFIED_HARDWARE,
};

export const fixtureScreenOnlyProfile: DeviceProfile = {
  id: "fixture.screen-only-round",
  name: "Fixture Screen-only Round LCD",
  formFactor: "round-lcd",
  display: {
    width: 360,
    height: 360,
    shape: "round",
    colorDepth: 16,
    safeArea: {
      x: 24,
      y: 24,
      width: 312,
      height: 312,
    },
  },
  touch: {
    supported: true,
    points: 1,
    gestures: ["tap", "swipe"],
  },
  capabilities: {
    input: ["text", "touch"],
    output: ["display", "expression", "viseme", "backlight"],
    control: ["interrupt", "behavior-playback", "brightness"],
  },
  joints: [],
  leds: [],
  backlight: {
    supported: true,
    min: 0,
    max: 1,
    hardwareVerification: UNVERIFIED_HARDWARE,
  },
  provenance: OFFICIAL_REFERENCE_SHAPE,
  hardwareVerification: UNVERIFIED_HARDWARE,
};

export const neutralBehavior: BehaviorTimeline = {
  id: "behavior.neutral",
  name: "Neutral",
  compatibleProfileIds: [],
  channels: ["expression", "viseme", "display", "backlight"],
  durationMs: 600,
  frames: [
    {
      atMs: 0,
      durationMs: 600,
      label: "neutral face",
      expression: {
        id: "neutral",
        intensity: 1,
        eyes: "open",
        mouth: "neutral",
      },
      viseme: {
        id: "sil",
        weight: 1,
      },
      display: {
        mode: "face",
        backgroundColor: "#101820",
      },
      backlight: {
        brightness: 0.7,
      },
    },
  ],
  provenance: HOST_GENERATED_FIXTURE,
  hardwareVerification: SIMULATED_ONLY,
};

export const happyLaughingBehavior: BehaviorTimeline = {
  id: "behavior.happy-laughing",
  name: "Happy Laughing",
  compatibleProfileIds: [],
  channels: ["expression", "viseme", "display", "backlight", "leds"],
  durationMs: 900,
  frames: [
    {
      atMs: 0,
      label: "smile",
      expression: {
        id: "happy",
        intensity: 0.8,
        eyes: "squint",
        mouth: "smile",
      },
      viseme: {
        id: "aa",
        weight: 0.4,
      },
      display: {
        mode: "face",
        backgroundColor: "#12372A",
      },
      backlight: {
        brightness: 0.85,
      },
      leds: {
        "status.rgb": {
          color: "#42F57B",
          brightness: 0.8,
          effect: "pulse",
        },
      },
    },
    {
      atMs: 280,
      durationMs: 260,
      label: "laugh",
      expression: {
        id: "laughing",
        intensity: 1,
        eyes: "closed",
        mouth: "laugh",
      },
      viseme: {
        id: "wide",
        weight: 0.9,
      },
    },
    {
      atMs: 640,
      label: "settle",
      expression: {
        id: "happy",
        intensity: 0.65,
        eyes: "open",
        mouth: "smile",
      },
      viseme: {
        id: "sil",
        weight: 1,
      },
    },
  ],
  provenance: HOST_GENERATED_FIXTURE,
  hardwareVerification: SIMULATED_ONLY,
};

export const angryBehavior: BehaviorTimeline = {
  id: "behavior.angry",
  name: "Angry",
  compatibleProfileIds: [],
  channels: ["expression", "display", "backlight", "leds"],
  durationMs: 700,
  frames: [
    {
      atMs: 0,
      durationMs: 700,
      label: "angry glare",
      expression: {
        id: "angry",
        intensity: 1,
        eyes: "squint",
        mouth: "frown",
      },
      display: {
        mode: "face",
        backgroundColor: "#2A0E12",
      },
      backlight: {
        brightness: 0.55,
      },
      leds: {
        "status.rgb": {
          color: "#FF2F2F",
          brightness: 1,
          effect: "solid",
        },
      },
    },
  ],
  provenance: HOST_GENERATED_FIXTURE,
  hardwareVerification: SIMULATED_ONLY,
};

export const danceSingAlongBehavior: BehaviorTimeline = {
  id: "behavior.dance-sing-along",
  name: "Dance Sing-along",
  compatibleProfileIds: [],
  channels: ["expression", "viseme", "joints", "display", "backlight", "leds"],
  durationMs: 1200,
  frames: [
    {
      atMs: 0,
      label: "ready",
      expression: {
        id: "happy",
        intensity: 0.7,
        eyes: "open",
        mouth: "smile",
      },
      viseme: {
        id: "sil",
        weight: 1,
      },
      joints: {
        "head.yaw": { value: -12 },
        "head.pitch": { value: 4 },
      },
      display: {
        mode: "face",
        backgroundColor: "#172033",
      },
      backlight: {
        brightness: 0.75,
      },
      leds: {
        "status.rgb": {
          color: "#52B6FF",
          brightness: 0.7,
          effect: "pulse",
        },
      },
    },
    {
      atMs: 250,
      label: "sing left",
      expression: {
        id: "singing",
        intensity: 0.9,
        eyes: "wide",
        mouth: "sing",
      },
      viseme: {
        id: "oh",
        weight: 0.8,
      },
      joints: {
        "head.yaw": { value: 14 },
        "head.pitch": { value: -6 },
      },
    },
    {
      atMs: 500,
      label: "sing right",
      expression: {
        id: "singing",
        intensity: 1,
        eyes: "squint",
        mouth: "open",
      },
      viseme: {
        id: "ee",
        weight: 0.75,
      },
      joints: {
        "head.yaw": { value: -16 },
        "head.pitch": { value: 8 },
      },
      leds: {
        "status.rgb": {
          color: "#FFDD4A",
          brightness: 0.9,
          effect: "blink",
        },
      },
    },
    {
      atMs: 800,
      label: "big note",
      expression: {
        id: "laughing",
        intensity: 1,
        eyes: "closed",
        mouth: "laugh",
      },
      viseme: {
        id: "aa",
        weight: 1,
      },
      joints: {
        "head.yaw": { value: 0 },
        "head.pitch": { value: -12 },
      },
      backlight: {
        brightness: 1,
      },
    },
    {
      atMs: 1000,
      durationMs: 200,
      label: "finish",
      expression: {
        id: "happy",
        intensity: 0.8,
        eyes: "open",
        mouth: "smile",
      },
      viseme: {
        id: "sil",
        weight: 1,
      },
      joints: {
        "head.yaw": { value: 0 },
        "head.pitch": { value: 0 },
      },
      leds: {
        "status.rgb": {
          color: "#42F57B",
          brightness: 0.6,
          effect: "solid",
        },
      },
    },
  ],
  provenance: HOST_GENERATED_FIXTURE,
  hardwareVerification: SIMULATED_ONLY,
};

export const deviceProfileFixtures: DeviceProfile[] = [
  fixtureMotionDisplayProfile,
  fixtureScreenOnlyProfile,
];

export const behaviorFixtures: BehaviorTimeline[] = [
  neutralBehavior,
  happyLaughingBehavior,
  angryBehavior,
  danceSingAlongBehavior,
];
