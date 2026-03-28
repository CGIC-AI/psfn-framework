export const MESSAGE_CLASSES = {
  outwardSpeech: 'outwardSpeech',
  systemNote: 'systemNote',
  internalWhisper: 'internalWhisper',
  compaction: 'compaction',
  continuity: 'continuity',
  mirror: 'mirror',
} as const;

export type MessageClass = typeof MESSAGE_CLASSES[keyof typeof MESSAGE_CLASSES];

export interface MessageClassMetadata {
  messageClass: MessageClass;
}

export type ClassifiedMessage<T extends object> = T & MessageClassMetadata;

export function tagMessageClass<T extends object>(
  message: T,
  messageClass: MessageClass,
): ClassifiedMessage<T> {
  return {
    ...message,
    messageClass,
  };
}
