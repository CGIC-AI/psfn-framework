import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

export interface PlayerClosedEvent {
  graceful: boolean;
  generation: number;
}

export class StreamingAudioPlayer extends EventEmitter<{
  closed: [PlayerClosedEvent];
}> {
  private process: ChildProcessByStdio<Writable, null, Readable> | null = null;
  private generation = 0;
  private gracefulByGeneration = new Map<number, boolean>();

  constructor(private readonly command: string[]) {
    super();
  }

  start(): number {
    this.stop();
    const generation = ++this.generation;
    const [bin, ...args] = this.command;
    const child = spawn(bin as string, args, {
      stdio: ["pipe", "ignore", "pipe"],
      detached: true,
    });
    this.process = child;
    this.gracefulByGeneration.set(generation, false);
    child.stderr.on("data", (raw: Buffer) => {
      const message = raw.toString("utf8").trim();
      if (message) {
        console.error(`[player] ${message}`);
      }
    });
    child.on("close", () => {
      if (this.process === child) {
        this.process = null;
      }
      const graceful = this.gracefulByGeneration.get(generation) ?? false;
      this.gracefulByGeneration.delete(generation);
      this.emit("closed", { graceful, generation });
    });
    return generation;
  }

  write(chunk: Buffer): void {
    if (!this.process || !this.process.stdin.writable) {
      return;
    }
    this.process.stdin.write(chunk);
  }

  finish(): void {
    if (!this.process || !this.process.stdin.writable) {
      return;
    }
    this.gracefulByGeneration.set(this.generation, true);
    this.process.stdin.end();
  }

  stop(): void {
    const child = this.process;
    if (!child) {
      return;
    }
    const generation = this.generation;
    this.process = null;
    this.gracefulByGeneration.set(generation, false);
    try {
      if (child.pid) {
        process.kill(-child.pid, "SIGKILL");
        return;
      }
    } catch {
      // Fall back to killing the direct child when group kill is unavailable.
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore teardown races.
    }
  }
}
