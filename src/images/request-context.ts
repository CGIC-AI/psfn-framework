import { AsyncLocalStorage } from 'node:async_hooks';

export interface VisionToolRequestContext {
  userMessageText: string;
  imageAttachmentUrls: string[];
}

const visionToolRequestContextStorage = new AsyncLocalStorage<VisionToolRequestContext>();

export function runWithVisionToolRequestContext<T>(
  context: VisionToolRequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return visionToolRequestContextStorage.run({
    userMessageText: context.userMessageText,
    imageAttachmentUrls: [...context.imageAttachmentUrls],
  }, fn);
}

export function getVisionToolRequestContext(): VisionToolRequestContext | undefined {
  return visionToolRequestContextStorage.getStore();
}
