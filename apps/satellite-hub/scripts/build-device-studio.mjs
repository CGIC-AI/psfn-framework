import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const sourceDir = path.join(rootDir, "src", "ts", "device-studio-app");
const compiledDir = path.join(rootDir, "dist", "ts", "device-studio-app");
const outputDir = path.join(rootDir, "dist", "device-studio");
const vendorDir = path.join(outputDir, "vendor");
const stackChanSourceAssetDir = path.join(rootDir, "assets", "device-studio", "stackchan", "source");

const assets = [
  ["index.html", "index.html"],
  ["styles.css", "styles.css"],
];

const vendorAssets = [
  [path.join(rootDir, "node_modules", "three", "build", "three.module.js"), "three.module.js"],
  [path.join(rootDir, "node_modules", "three", "build", "three.core.js"), "three.core.js"],
  [
    path.join(rootDir, "node_modules", "three", "examples", "jsm", "loaders", "STLLoader.js"),
    path.join("three-examples", "jsm", "loaders", "STLLoader.js"),
  ],
];

const browserExcludedModuleNames = new Set([
  "fal-provider.js",
  "sprite-cli.js",
  "sprites.js",
]);

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(vendorDir, { recursive: true });

for (const [sourceName, outputName] of assets) {
  const sourcePath = path.isAbsolute(sourceName)
    ? sourceName
    : path.join(sourceDir, sourceName);
  await fs.copyFile(sourcePath, path.join(outputDir, outputName));
}

for (const [sourcePath, outputName] of vendorAssets) {
  const outputPath = path.join(vendorDir, outputName);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(sourcePath, outputPath);
}

await copyCompiledTree(compiledDir, outputDir);
await copyCompiledTree(path.join(rootDir, "dist", "ts", "device-studio"), path.join(outputDir, "device-studio"), {
  excludeModuleNames: browserExcludedModuleNames,
});
await copyCompiledTree(path.join(rootDir, "dist", "ts", "shared"), path.join(outputDir, "shared"));
await copyStaticTree(stackChanSourceAssetDir, path.join(outputDir, "assets", "stackchan", "source"));

console.log(`Built Device Studio at ${path.relative(rootDir, outputDir)}`);

async function copyCompiledTree(from, to, options = {}) {
  const excludeModuleNames = options.excludeModuleNames ?? new Set();

  await fs.cp(from, to, {
    recursive: true,
    filter: (sourcePath) => {
      if (sourcePath.endsWith(".test.js")) {
        return false;
      }
      return !excludeModuleNames.has(path.basename(sourcePath));
    },
  });
}

async function copyStaticTree(from, to) {
  await fs.cp(from, to, {
    recursive: true,
  });
}
