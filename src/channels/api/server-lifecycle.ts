export type LifecycleInterrupt = 'timeout' | 'client_disconnected';

export class RequestLifecycleError extends Error {
  readonly reason: LifecycleInterrupt;

  constructor(reason: LifecycleInterrupt) {
    super(reason);
    this.reason = reason;
  }
}

export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
