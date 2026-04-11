import { AsyncLocalStorage } from 'node:async_hooks';

export interface CurrentTurnVisionReviewContext {
  imageUrls: string[];
  question: string;
  summary: string;
}

export interface VisionToolRequestContext {
  userMessageText: string;
  imageAttachmentUrls: string[];
  currentTurnVisionReview?: CurrentTurnVisionReviewContext;
}

const visionToolRequestContextStorage = new AsyncLocalStorage<VisionToolRequestContext>();

export function runWithVisionToolRequestContext<T>(
  context: VisionToolRequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return visionToolRequestContextStorage.run({
    userMessageText: context.userMessageText,
    imageAttachmentUrls: [...context.imageAttachmentUrls],
    ...(context.currentTurnVisionReview
      ? {
        currentTurnVisionReview: {
          imageUrls: [...context.currentTurnVisionReview.imageUrls],
          question: context.currentTurnVisionReview.question,
          summary: context.currentTurnVisionReview.summary,
        },
      }
      : {}),
  }, fn);
}

export function getVisionToolRequestContext(): VisionToolRequestContext | undefined {
  return visionToolRequestContextStorage.getStore();
}
