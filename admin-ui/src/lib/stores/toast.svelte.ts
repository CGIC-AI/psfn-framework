export type ToastKind = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: number;
  message: string;
  kind: ToastKind;
}

let queue = $state<ToastMessage[]>([]);
let nextId = 1;

export function getToasts(): ToastMessage[] {
  return queue;
}

export function pushToast(
  message: string,
  kind: ToastKind = 'info',
  timeoutMs = 3500,
): number {
  const id = nextId++;
  queue = [...queue, { id, message, kind }];
  setTimeout(() => {
    removeToast(id);
  }, timeoutMs);
  return id;
}

export function removeToast(id: number): void {
  queue = queue.filter((toast) => toast.id !== id);
}
