import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { hubConsole } from "./private-log.js";

const DIRECTORY = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const FILE = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const DEFAULT_RETENTION_HOURS = 24;

function descriptorPath(fd: number, leaf = ""): string { return `/proc/self/fd/${fd}${leaf ? `/${leaf}` : ""}`; }

function relativeTarget(root: string, target: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Private artifact containment rejected");
  return relative;
}

function directory(target: string, create: boolean, privateRoot: string): number {
  if (process.platform !== "linux" || !fs.constants.O_NOFOLLOW) throw new Error("Private artifacts require Linux descriptor-safe filesystem support");
  const absolute = path.resolve(target);
  const root = path.resolve(privateRoot);
  if ([path.parse(root).root, os.homedir(), process.cwd()].includes(root)) throw new Error("Private artifact root must be a dedicated directory");
  let fd = fs.openSync(path.parse(absolute).root, DIRECTORY);
  let traversed = path.parse(absolute).root;
  try {
    for (const component of absolute.split(path.sep).filter(Boolean)) {
      const next = descriptorPath(fd, component);
      if (create) {
        try { fs.mkdirSync(next, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const child = fs.openSync(next, DIRECTORY);
      fs.closeSync(fd); fd = child;
      traversed = path.join(traversed, component);
      if (traversed === root || traversed.startsWith(root + path.sep)) fs.fchmodSync(fd, 0o700);
    }
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

function regular(fd: number): void {
  const stats = fs.fstatSync(fd);
  if (!stats.isFile() || stats.nlink !== 1) throw new Error("Private artifact must be an unaliased regular file");
}

export function privateDirectory(root: string, target = root): void {
  if (path.resolve(target) !== path.resolve(root)) relativeTarget(root, target);
  const fd = directory(target, true, root); fs.closeSync(fd);
}

export function readPrivateArtifact(root: string, target: string, maxBytes = Number.MAX_SAFE_INTEGER): Buffer {
  relativeTarget(root, target);
  const parent = directory(path.dirname(target), false, root);
  let fd: number | undefined;
  try {
    fd = fs.openSync(descriptorPath(parent, path.basename(target)), fs.constants.O_RDONLY | FILE);
    regular(fd);
    const size = fs.fstatSync(fd).size;
    if (size > maxBytes) throw new Error("Private artifact exceeds read budget");
    const result = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(fd, result, offset, size - offset, null);
      if (!count) throw new Error("Private artifact changed during read");
      offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error("Private artifact changed during read");
    return result;
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(parent); }
}

export function writePrivateArtifact(root: string, target: string, data: string | Buffer, append = false): void {
  relativeTarget(root, target);
  const parent = directory(path.dirname(target), true, root);
  const destination = descriptorPath(parent, path.basename(target));
  const temporary = descriptorPath(parent, `.private-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let committed = false;
  try {
    try {
      const stats = fs.lstatSync(destination);
      if (!stats.isFile() || stats.nlink !== 1) throw new Error("Private artifact destination rejected");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    fd = fs.openSync(append ? destination : temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | FILE | (append ? fs.constants.O_APPEND : fs.constants.O_EXCL), 0o600);
    regular(fd); fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (!append) fs.renameSync(temporary, destination);
    fs.fsyncSync(parent); committed = true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!committed && !append) { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    fs.closeSync(parent);
  }
}

export function cleanupPrivateArtifacts(root: string, now = Date.now(), retentionHours = DEFAULT_RETENTION_HOURS): number {
  if (!Number.isInteger(retentionHours) || retentionHours < 1 || retentionHours > 168) throw new Error("Artifact retention must be 1-168 hours");
  let rootFd: number;
  try { rootFd = directory(root, false, root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  const cutoff = now - retentionHours * 60 * 60 * 1000;
  let removed = 0;
  const visit = (fd: number, depth: number): void => {
    if (depth > 8) throw new Error("Private artifact directory depth exceeded");
    for (const entry of fs.readdirSync(descriptorPath(fd), { withFileTypes: true })) {
      const filename = descriptorPath(fd, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0 && !/^(?:\d{8}|voxta-audio|voxta-vision|eidoverse-vision|audio|interactions)$/u.test(entry.name)) continue;
        let child: number | undefined;
        try { child = fs.openSync(filename, DIRECTORY); fs.fchmodSync(child, 0o700); visit(child, depth + 1); }
        catch (error) { if (!["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        finally { if (child !== undefined) fs.closeSync(child); }
        try { fs.rmdirSync(filename); } catch (error) { if (!["ENOTEMPTY", "ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      } else if (entry.isFile() && (depth > 0 || /^(?:voxta_.*\.wav|runtime-events\.jsonl|device_info\.json)$/u.test(entry.name))) {
        let file: number | undefined;
        try {
          file = fs.openSync(filename, fs.constants.O_RDONLY | FILE);
          const stats = fs.fstatSync(file);
          if (!stats.isFile() || stats.nlink !== 1) continue;
          fs.fchmodSync(file, 0o600);
          if (stats.mtimeMs < cutoff) { fs.unlinkSync(filename); removed += 1; }
        } catch (error) { if (!["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        finally { if (file !== undefined) fs.closeSync(file); }
      }
    }
  };
  try { visit(rootFd, 0); return removed; } finally { fs.closeSync(rootFd); }
}

export function startPrivateArtifactRetention(input: string | readonly string[]): () => void {
  const roots = typeof input === "string" ? [input] : [...new Set(input)];
  let hours = DEFAULT_RETENTION_HOURS;
  const policyPath = process.env.HUB_ARTIFACT_POLICY_PATH?.trim();
  if (policyPath) {
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8")) as { schemaVersion?: unknown; retentionHours?: unknown };
    if (policy.schemaVersion !== 1 || Object.keys(policy).sort().join(",") !== "retentionHours,schemaVersion"
      || !Number.isInteger(policy.retentionHours) || Number(policy.retentionHours) < 1 || Number(policy.retentionHours) > 168) throw new Error("Invalid Hub artifact retention policy");
    hours = Number(policy.retentionHours);
  }
  // Initialize every root before installing the single timer: partial startup
  // failure cannot strand a timer for an already-visited root.
  for (const root of roots) cleanupPrivateArtifacts(root, Date.now(), hours);
  const timer = setInterval(() => {
    for (const root of roots) {
      try { cleanupPrivateArtifacts(root, Date.now(), hours); }
      catch (error) { hubConsole.error("Hub artifact expiry failed", error); }
    }
  }, 60_000);
  timer.unref(); return () => clearInterval(timer);
}
