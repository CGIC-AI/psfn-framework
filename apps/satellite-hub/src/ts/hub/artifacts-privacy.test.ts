import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createHook } from "node:async_hooks";
import { appendEvent, appendPcm, createArtifactTurn, finalizeWav, writeJson } from "./artifacts.js";
import { cleanupPrivateArtifacts, readPrivateArtifact, startPrivateArtifactRetention, writePrivateArtifact } from "../shared/private-artifacts.js";

test("actual sensitive artifact files and every owned directory are private under an open umask", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-private-"));
  const root = path.join(temporary, "artifacts");
  const previous = process.umask(0);
  try {
    const turn = createArtifactTurn(root, "invented-session");
    appendPcm(turn, Buffer.alloc(4)); finalizeWav(turn);
    appendEvent(turn, "transcript", { text: "INVENTED_PRIVATE_CONTENT" });
    writeJson(turn, turn.replyPath, { text: "INVENTED_PRIVATE_REPLY" });
    for (const filename of [turn.pcmPath, turn.wavPath, turn.eventsPath, turn.replyPath]) assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    for (const directory of [root, path.dirname(turn.directory), turn.directory]) assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.match(fs.readFileSync(turn.replyPath, "utf8"), /INVENTED_PRIVATE_REPLY/);
    assert.equal(readPrivateArtifact(root, turn.pcmPath, 4).length, 4);
    assert.throws(() => readPrivateArtifact(root, turn.pcmPath, 3));
  } finally { process.umask(previous); fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("contained writes reject sibling paths, intermediate and destination symlinks, and hardlinks", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-hostile-"));
  const root = path.join(temporary, "artifacts"); const outside = path.join(temporary, "outside");
  fs.mkdirSync(root); fs.mkdirSync(outside);
  const target = path.join(outside, "keep.txt"); fs.writeFileSync(target, "PRIVATE_OUTSIDE_SENTINEL");
  try {
    fs.symlinkSync(outside, path.join(root, "20261023"));
    assert.throws(() => writePrivateArtifact(root, path.join(root, "20261023", "transcript.json"), "no"));
    for (const destination of [path.join(root, "linked.json"), path.join(root, "hardlinked.json")]) {
      if (destination.includes("hardlinked")) fs.linkSync(target, destination); else fs.symlinkSync(target, destination);
      assert.throws(() => writePrivateArtifact(root, destination, "no"));
      assert.throws(() => writePrivateArtifact(root, destination, "no", true));
      assert.throws(() => readPrivateArtifact(root, destination));
    }
    for (const destination of [path.join(root, "..", "outside", "new.json"), root + "-sibling/file.json", root]) assert.throws(() => writePrivateArtifact(root, destination, "no"));
    assert.equal(fs.readFileSync(target, "utf8"), "PRIVATE_OUTSIDE_SENTINEL");
    assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("intermediate symlink swaps cannot redirect pinned artifact writes outside the root", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-race-"));
  const root = path.join(temporary, "artifacts"); const outside = path.join(temporary, "outside");
  fs.mkdirSync(root); fs.mkdirSync(outside); fs.mkdirSync(path.join(root, "20261023"));
  const worker = new Worker(`const fs=require('node:fs');const {workerData,parentPort}=require('node:worker_threads');const [root,outside]=workerData;parentPort.postMessage('ready');for(let i=0;i<2000;i++){try{fs.renameSync(root+'/20261023',root+'/held');fs.symlinkSync(outside,root+'/20261023');fs.unlinkSync(root+'/20261023');fs.renameSync(root+'/held',root+'/20261023');}catch{}}`, { eval: true, workerData: [root, outside] });
  try {
    await new Promise<void>((resolve) => worker.once("message", () => resolve()));
    for (let index = 0; index < 200; index++) {
      try { writePrivateArtifact(root, path.join(root, "20261023", `reply-${index}.json`), "PRIVATE_REPLY_SENTINEL"); }
      catch (error) { assert.ok(["ELOOP", "ENOTDIR", "ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")); }
    }
    await worker.terminate();
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { await worker.terminate(); fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("retention expires every sensitive format, preserves fresh content, repairs modes, and never traverses links", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-expiry-"));
  const root = path.join(temporary, "artifacts"); const outside = path.join(temporary, "outside");
  fs.mkdirSync(outside); const target = path.join(outside, "keep.json"); fs.writeFileSync(target, "OUTSIDE_SENTINEL");
  const now = Date.now(); const expired = new Date(now - 25 * 60 * 60 * 1000);
  const fresh: string[] = [];
  try {
    for (const name of ["20261023/turn/audio.pcm", "20261023/turn/audio.wav", "20261023/turn/transcript.json", "20261023/turn/reply.json", "20261023/turn/events.jsonl", "voxta-audio/audio.wav", "voxta-vision/20261023/image.jpg", "eidoverse-vision/20261023/image.png"]) {
      const old = path.join(root, name); writePrivateArtifact(root, old, "OLD_PRIVATE_SENTINEL"); fs.utimesSync(old, expired, expired);
      const current = old + ".fresh"; writePrivateArtifact(root, current, "FRESH_PRIVATE_SENTINEL"); fs.chmodSync(current, 0o666); fresh.push(current);
    }
    fs.symlinkSync(outside, path.join(root, "20261022"));
    fs.symlinkSync(target, path.join(root, "voxta-vision", "20261023", "linked.json"));
    assert.equal(cleanupPrivateArtifacts(root, now, 24), 8);
    for (const filename of fresh) { assert.equal(fs.readFileSync(filename, "utf8"), "FRESH_PRIVATE_SENTINEL"); assert.equal(fs.statSync(filename).mode & 0o777, 0o600); }
    assert.equal(fs.readFileSync(target, "utf8"), "OUTSIDE_SENTINEL");
    assert.throws(() => cleanupPrivateArtifacts(root, now, 0));
    assert.throws(() => cleanupPrivateArtifacts(root, now, 169));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("artifact roots and final files cannot follow symlinks or alias outside content", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-symlink-"));
  const outside = path.join(temporary, "outside"); fs.mkdirSync(outside);
  const root = path.join(temporary, "artifacts"); fs.symlinkSync(outside, root);
  try {
    assert.throws(() => createArtifactTurn(root, "invented-session"));
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("partial retention initialization installs no timer when a later root is unsafe", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-startup-"));
  const good = path.join(temporary, "good"); const unsafe = path.join(temporary, "unsafe");
  fs.mkdirSync(good); fs.symlinkSync(good, unsafe);
  let timers = 0;
  const hook = createHook({ init: (_id, type) => { if (type === "Timeout") timers += 1; } });
  try {
    hook.enable(); assert.throws(() => startPrivateArtifactRetention([good, unsafe])); hook.disable();
    assert.equal(timers, 0);
  } finally { hook.disable(); fs.rmSync(temporary, { recursive: true, force: true }); }
});
