import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";

import { pcm16Gain, pcm16MonoRms } from "../shared/audio.js";

export interface AudioChunk {
  pcm: Buffer;
  rms: number;
  capturedAt: number;
}

export class AudioCapture extends EventEmitter<{
  audio: [AudioChunk];
  close: [];
  error: [Error];
}> {
  private process: ChildProcessByStdio<null, Readable, Readable> | null = null;

  constructor(
    private readonly command: string[],
    private readonly micGain: number,
  ) {
    super();
  }

  start(): void {
    if (this.process) {
      return;
    }
    const [bin, ...args] = this.command;
    this.process = spawn(bin as string, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const process = this.process;
    if (!process) {
      return;
    }
    process.stdout.on("data", (raw: Buffer) => {
      const pcm = this.micGain === 1 ? raw : pcm16Gain(raw, this.micGain);
      this.emit("audio", {
        pcm,
        rms: pcm16MonoRms(pcm),
        capturedAt: Date.now(),
      });
    });
    process.stderr.on("data", (raw: Buffer) => {
      const message = raw.toString("utf8").trim();
      if (message) {
        console.error(`[capture] ${message}`);
      }
    });
    process.on("close", () => {
      this.process = null;
      this.emit("close");
    });
    process.on("error", (error) => {
      this.emit("error", error);
    });
  }

  stop(): void {
    this.process?.kill("SIGKILL");
    this.process = null;
  }
}
