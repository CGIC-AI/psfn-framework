import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetRoot = path.join(projectRoot, "satellites", "waveshare-bedroom");
const outputRoot = path.join(targetRoot, ".generated");
const lock = JSON.parse(await readFile(path.join(targetRoot, "source-lock.json"), "utf8"));

const wakeWordModel = await readFile(path.join(targetRoot, "wakeword", "purrsephone.tflite"));
const wakeWordDigest = createHash("sha256").update(wakeWordModel).digest("hex");
const lockedWakeWordDigest = lock.sources?.["purrsephone-micro-wake-word"]?.sha256;
if (wakeWordDigest !== lockedWakeWordDigest) {
  throw new Error(
    `Purrsephone wake-word SHA-256 mismatch: expected ${lockedWakeWordDigest}, got ${wakeWordDigest}`,
  );
}

const revision = (name) => {
  const value = lock.sources?.[name]?.revision;
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`source-lock.json has no immutable revision for ${name}`);
  }
  return value;
};

const intercomRevision = revision("esphome-intercom");
const profilePath = "yamls/experimental/waveshare-s3-touch-lcd-1.85c/"
  + "waveshare-s3-touch-lcd-1.85c-box-full-afe.yaml";
const partitionPath = "yamls/experimental/waveshare-s3-touch-lcd-1.85c/"
  + "partitions_16mb_huge_factory.csv";

const fetchText = async (url) => {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Unable to fetch ${url}: HTTP ${response.status}`);
  return response.text();
};

const raw = (repository, ref, file) =>
  `https://raw.githubusercontent.com/${repository}/${ref}/${file}`;

let profile = await fetchText(raw("n-IA-hane/esphome-intercom", intercomRevision, profilePath));
const partitions = await fetchText(raw("n-IA-hane/esphome-intercom", intercomRevision, partitionPath));

const repositoryPins = new Map([
  ["n-IA-hane/esphome-intercom", intercomRevision],
  ["n-IA-hane/esphome-voip-stack", revision("esphome-voip-stack")],
  ["n-IA-hane/esphome-audio-stack", revision("esphome-audio-stack")],
  ["n-IA-hane/esphome-runtime-controller", revision("esphome-runtime-controller")],
]);

for (const [repository, ref] of repositoryPins) {
  profile = profile.replaceAll(`github://${repository}@main`, `github://${repository}@${ref}`);
  profile = profile.replaceAll(`github://${repository}/`, `github://${repository}/`);
  profile = profile.replaceAll(`@main`, (match, offset, source) => {
    const lineStart = source.lastIndexOf("\n", offset) + 1;
    const line = source.slice(lineStart, source.indexOf("\n", offset));
    return line.includes(`github://${repository}/`) ? `@${ref}` : match;
  });
}

profile = profile.replaceAll(
  "https://github.com/n-IA-hane/esphome-intercom/raw/main/",
  `https://raw.githubusercontent.com/n-IA-hane/esphome-intercom/${intercomRevision}/`,
);
profile = profile.replaceAll(
  "https://github.com/Templarian/MaterialDesign-Webfont/raw/master/",
  `https://raw.githubusercontent.com/Templarian/MaterialDesign-Webfont/${revision("material-design-webfont")}/`,
);

const googleFontsRevision = revision("google-fonts");
const figtreeUrl = `https://raw.githubusercontent.com/google/fonts/${googleFontsRevision}/ofl/figtree/Figtree%5Bwght%5D.ttf`;
const robotoMonoUrl = `https://raw.githubusercontent.com/google/fonts/${googleFontsRevision}/ofl/robotomono/RobotoMono%5Bwght%5D.ttf`;
profile = profile.replace(
  /file:\n\s+type: gfonts\n\s+family: \$\{font_family\}\n\s+weight: \d+/g,
  `file: "${figtreeUrl}"`,
);
profile = profile.replace(
  /file:\n\s+type: gfonts\n\s+family: Roboto Mono\n\s+weight: \d+/g,
  `file: "${robotoMonoUrl}"`,
);
// PlatformIO resolves this value from its generated build directory, not from
// the YAML containing it. The prepared file is local runtime state, so an
// absolute path keeps compilation reliable from every caller working directory.
profile = profile.replaceAll(
  "../../../partitions_16mb_huge_factory.csv",
  path.join(outputRoot, "partitions_16mb_huge_factory.csv"),
);
profile = profile.replace("timezone: Europe/Rome", "timezone: America/New_York");

const replaceRequired = (search, replacement, label) => {
  if (!profile.includes(search)) throw new Error(`Prepared profile is missing ${label}`);
  profile = profile.replace(search, replacement);
};

// Keep wake detection on the ESP32 and bind it to the repo-owned model. The
// ESPHome voice-assistant transport is consumed by the Satellite Hub fallback
// bridge; Home Assistant Assist is not part of this turn path.
replaceRequired(
  "    - model: alexa",
  `    - model: ${path.join(targetRoot, "wakeword", "purrsephone.json")}`,
  "upstream Alexa wake-word model",
);

// The upstream mute switch only powered the NS4150B amplifier when it was
// toggled off during active playback. On a normal boot the switch already
// starts off, leaving GPIO15 low while the media player reports PLAYING. Power
// the amplifier whenever either playback pipeline starts; explicit mute still
// turns it off.
replaceRequired(
  "    on_announcement:\n      - runtime_controller.event:\n          id: runtime\n          event: announcement_started\n",
  "    on_announcement:\n      - if:\n          condition:\n            switch.is_off: speaker_mute\n          then:\n            - output.turn_on: speaker_enable\n            - delay: 50ms\n      - runtime_controller.event:\n          id: runtime\n          event: announcement_started\n",
  "announcement amplifier enable",
);
replaceRequired(
  "    on_play:\n      - runtime_controller.event:\n          id: runtime\n          event: media_playing\n",
  "    on_play:\n      - if:\n          condition:\n            switch.is_off: speaker_mute\n          then:\n            - output.turn_on: speaker_enable\n            - delay: 50ms\n      - runtime_controller.event:\n          id: runtime\n          event: media_playing\n",
  "media amplifier enable",
);

// Preserve the upstream widget IDs and lifecycle scripts while replacing its
// borrowed character art with the repo-owned Purrsephone state sprites.
const idleAnimation = /(        - animimg:\n            id: idle_anim[\s\S]*?            src:\n)[\s\S]*?(            duration: 6600ms)/;
if (!idleAnimation.test(profile)) throw new Error("Prepared profile is missing the idle animation");
profile = profile.replace(idleAnimation, "$1              - purrsephone_idle\n$2");
replaceRequired(
  "src: assistant_gui_listening",
  "src: purrsephone_idle\n        - label:\n            text: \"Listening...\"\n            align: BOTTOM_MID\n            y: -18\n            text_font: montserrat_20\n            text_color: 0x8B5CF6",
  "listening sprite",
);
replaceRequired("src: assistant_gui_thinking", "src: purrsephone_thinking", "thinking sprite");
replaceRequired("src: assistant_gui_initializing", "src: purrsephone_sleeping", "initializing sprite");
replaceRequired("src: assistant_gui_error", "src: purrsephone_sleeping", "error sprite");
replaceRequired("src: assistant_gui_timer_finished", "src: purrsephone_idle", "timer sprite");
replaceRequired("src: error_no_ha", "src: purrsephone_idle", "disconnected sprite");
replaceRequired("src: error_no_wifi", "src: purrsephone_sleeping", "offline sprite");
replaceRequired("src: mood_neutral", "src: purrsephone_talking", "replying sprite");
profile = profile.replaceAll("id(mood_neutral)", "id(purrsephone_talking)");
profile = profile.replaceAll("id(mood_happy)", "id(purrsephone_talking)");
profile = profile.replaceAll("id(mood_angry)", "id(purrsephone_talking)");

// Once every reference has been redirected, drop the borrowed character
// files entirely. Keeping unused upstream frames in the image list both wastes
// flash and makes it possible for a future page to show the wrong character.
profile = profile.replace(
  /  - file: \$\{assets_base\}assets\/images\/assistant\/[^\n]+\n    id: [^\n]+\n    resize: 360x360\n    type: RGB565\n    transparency: (?:alpha_channel|opaque)\n/g,
  "",
);
profile = profile.replace(
  /^\s*# AI avatar folder.*\n\s*ai_avatar:.*\n/m,
  "",
);

// The borrowed muted page was empty. Every face-state page must render one of
// the repo-owned Purrsephone sprites, even while audio input is muted.
replaceRequired(
  "    - id: muted_page\n      bg_color: 0x000000\n      on_swipe_up:\n        - script.execute: swipe_to_voip\n",
  "    - id: muted_page\n      bg_color: 0x000000\n      on_swipe_up:\n        - script.execute: swipe_to_voip\n      widgets:\n        - image:\n            align: CENTER\n            src: purrsephone_sleeping\n",
  "muted sprite",
);

// The optional artwork package depends on a mutable ESPHome pull-request head.
// The base profile already supplies a deterministic neutral-art fallback, so
// omit remote album artwork until the component exists in a pinned release.
profile = profile.replace(/^\s+sendspin_artwork:.*\n/m, "");

const forbidden = [
  "@main",
  "/raw/main/",
  "/raw/master/",
  "type: gfonts",
  "github://pr#",
  "assets/images/assistant/",
  "assistant_gui_",
  "model: alexa",
  "id: mood_happy",
  "id: mood_neutral",
  "id: mood_angry",
];
for (const token of forbidden) {
  if (profile.includes(token)) throw new Error(`Prepared profile still contains floating reference: ${token}`);
}

await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, "upstream-profile.yaml"), profile, "utf8");
await writeFile(path.join(outputRoot, "partitions_16mb_huge_factory.csv"), partitions, "utf8");
console.log(`Prepared locked Waveshare profile at ${path.relative(projectRoot, outputRoot)}`);
