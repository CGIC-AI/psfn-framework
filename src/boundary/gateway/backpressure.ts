export type QueueOverflowPolicy = 'error' | 'drop_oldest' | 'drop_newest';

export interface BoundedQueueOptions<T> {
  maxSize: number;
  overflowPolicy?: QueueOverflowPolicy;
  onDrop?: (item: T, reason: 'drop_oldest' | 'drop_newest') => void;
}

export interface QueueEnqueueResult<T> {
  accepted: boolean;
  dropped?: T;
  droppedReason?: 'drop_oldest' | 'drop_newest';
  size: number;
}

export class QueueOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueOverflowError';
  }
}

export class BoundedQueue<T> {
  private readonly maxSize: number;
  private readonly overflowPolicy: QueueOverflowPolicy;
  private readonly onDrop?: (item: T, reason: 'drop_oldest' | 'drop_newest') => void;
  private readonly items: T[] = [];

  constructor(options: BoundedQueueOptions<T>) {
    if (!Number.isInteger(options.maxSize) || options.maxSize <= 0) {
      throw new Error(`maxSize must be a positive integer, got: ${options.maxSize}`);
    }
    this.maxSize = options.maxSize;
    this.overflowPolicy = options.overflowPolicy ?? 'error';
    this.onDrop = options.onDrop;
  }

  enqueue(item: T): QueueEnqueueResult<T> {
    if (this.items.length < this.maxSize) {
      this.items.push(item);
      return { accepted: true, size: this.items.length };
    }

    if (this.overflowPolicy === 'error') {
      throw new QueueOverflowError(`Queue overflow: capacity ${this.maxSize}`);
    }

    if (this.overflowPolicy === 'drop_newest') {
      this.onDrop?.(item, 'drop_newest');
      return {
        accepted: false,
        dropped: item,
        droppedReason: 'drop_newest',
        size: this.items.length,
      };
    }

    const dropped = this.items.shift();
    if (dropped !== undefined) {
      this.onDrop?.(dropped, 'drop_oldest');
    }
    this.items.push(item);
    return {
      accepted: true,
      dropped,
      droppedReason: dropped !== undefined ? 'drop_oldest' : undefined,
      size: this.items.length,
    };
  }

  dequeue(): T | undefined {
    return this.items.shift();
  }

  clear(): T[] {
    const drained = this.items.slice();
    this.items.length = 0;
    return drained;
  }

  get size(): number {
    return this.items.length;
  }

  get capacity(): number {
    return this.maxSize;
  }
}
