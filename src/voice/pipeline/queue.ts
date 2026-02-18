import {
  INTERRUPT_CONTROL_COMMANDS,
  isVoiceControlFrame,
  type VoiceControlCommand,
  type VoiceControlFrame,
  type VoiceDataFrame,
  type VoiceFrame,
} from './frames.js';

export interface ControlPriorityQueueOptions {
  readonly interruptCommands?: readonly VoiceControlCommand[];
}

export interface EnqueueResult {
  readonly droppedInterruptible: number;
  readonly size: number;
}

export class ControlPriorityFrameQueue {
  private readonly controlFrames: VoiceControlFrame[] = [];
  private readonly dataFrames: VoiceDataFrame[] = [];
  private readonly interruptCommands: Set<VoiceControlCommand>;

  constructor(options: ControlPriorityQueueOptions = {}) {
    this.interruptCommands = new Set(options.interruptCommands ?? INTERRUPT_CONTROL_COMMANDS);
  }

  get size(): number {
    return this.controlFrames.length + this.dataFrames.length;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  enqueue(frame: VoiceFrame): EnqueueResult {
    if (isVoiceControlFrame(frame)) {
      const droppedInterruptible = this.interruptCommands.has(frame.payload.command)
        ? this.dropInterruptibleDataFrames()
        : 0;

      this.controlFrames.push(frame);
      return { droppedInterruptible, size: this.size };
    }

    this.dataFrames.push(frame);
    return { droppedInterruptible: 0, size: this.size };
  }

  peek(): VoiceFrame | undefined {
    return this.controlFrames[0] ?? this.dataFrames[0];
  }

  dequeue(): VoiceFrame | undefined {
    if (this.controlFrames.length > 0) {
      return this.controlFrames.shift();
    }
    return this.dataFrames.shift();
  }

  clear(): void {
    this.controlFrames.length = 0;
    this.dataFrames.length = 0;
  }

  private dropInterruptibleDataFrames(): number {
    const before = this.dataFrames.length;
    const retained = this.dataFrames.filter((frame) => !frame.interruptible);
    this.dataFrames.length = 0;
    this.dataFrames.push(...retained);
    return before - retained.length;
  }
}
