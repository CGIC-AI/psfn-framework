import { readFile, writeFile } from "node:fs/promises";

import { packDeviceSpriteSheet } from "./sprites.js";
import type { SpriteFrameKind, SpriteSourceFrame } from "./sprites.js";

interface ParsedCliArgs {
  profileId: string;
  atlasPath: string;
  manifestPath: string;
  frames: Array<{
    kind: SpriteFrameKind;
    id: string;
    path: string;
  }>;
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const frames: SpriteSourceFrame[] = await Promise.all(args.frames.map(async (frame) => ({
    id: frame.id,
    kind: frame.kind,
    png: await readFile(frame.path),
    provenance: {
      label: frame.path,
      source: "user-authored",
    },
  })));

  const result = packDeviceSpriteSheet({
    profileId: args.profileId,
    frames,
  });

  await writeFile(args.atlasPath, result.atlasPng);
  await writeFile(args.manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
}

function parseArgs(argv: string[]): ParsedCliArgs {
  let profileId = "";
  let atlasPath = "";
  let manifestPath = "";
  const frames: ParsedCliArgs["frames"] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      profileId = readFlagValue(argv, ++index, arg);
    } else if (arg === "--out-atlas") {
      atlasPath = readFlagValue(argv, ++index, arg);
    } else if (arg === "--out-manifest") {
      manifestPath = readFlagValue(argv, ++index, arg);
    } else if (arg === "--frame") {
      frames.push(parseFrameSpec(readFlagValue(argv, ++index, arg)));
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    } else {
      throw new Error(`Unknown argument: ${arg ?? ""}`);
    }
  }

  if (!profileId || !atlasPath || !manifestPath || frames.length === 0) {
    printUsageAndExit(1);
  }

  return { profileId, atlasPath, manifestPath, frames };
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseFrameSpec(spec: string): ParsedCliArgs["frames"][number] {
  const [kind, id, ...pathParts] = spec.split(":");
  const path = pathParts.join(":");
  if ((kind !== "expression" && kind !== "viseme") || !id || !path) {
    throw new Error(`Invalid frame spec "${spec}". Expected kind:id:path.png`);
  }
  return { kind, id, path };
}

function printUsageAndExit(code: number): never {
  const usage = [
    "Usage:",
    "  node dist/ts/device-studio/sprite-cli.js --profile <profile-id> --out-atlas atlas.png --out-manifest manifest.json --frame expression:neutral:neutral.png",
    "",
    "Frame specs use kind:id:path.png, where kind is expression or viseme.",
  ].join("\n");
  if (code === 0) {
    console.log(usage);
  } else {
    console.error(usage);
  }
  process.exit(code);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
