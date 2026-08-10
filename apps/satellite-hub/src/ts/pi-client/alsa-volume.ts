import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AlsaDuckingConfig {
  mixerCard: string;
  mixerControl: string;
  duckPercent: number;
}

export class AlsaVolumeController {
  private originalPercent: number | null = null;
  private ducked = false;
  private serial: Promise<void> = Promise.resolve();

  constructor(private readonly config: AlsaDuckingConfig) {}

  duck(): Promise<void> {
    return this.enqueue(async () => {
      if (this.ducked) {
        return;
      }
      const current = await this.getPercent();
      if (current === null) {
        return;
      }
      this.originalPercent = current;
      if (current > this.config.duckPercent) {
        await this.setPercent(this.config.duckPercent);
      }
      this.ducked = true;
    });
  }

  restore(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.ducked || this.originalPercent === null) {
        return;
      }
      await this.setPercent(this.originalPercent);
      this.ducked = false;
    });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    this.serial = this.serial
      .then(action)
      .catch((error) => {
        console.error("ALSA volume control failed:", error);
      });
    return this.serial;
  }

  private async getPercent(): Promise<number | null> {
    const { stdout } = await execFileAsync("amixer", [
      "-c",
      this.config.mixerCard,
      "sget",
      this.config.mixerControl,
    ]);
    const matches = [...stdout.matchAll(/\[(\d+)%\]/g)];
    const value = matches.at(-1)?.[1];
    return value ? Number.parseInt(value, 10) : null;
  }

  private async setPercent(percent: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    await execFileAsync("amixer", [
      "-q",
      "-c",
      this.config.mixerCard,
      "sset",
      this.config.mixerControl,
      `${clamped}%`,
    ]);
  }
}
