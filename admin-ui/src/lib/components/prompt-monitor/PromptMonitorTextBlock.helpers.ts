export interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

export async function writePromptMonitorClipboard(
  value: string,
  clipboard: ClipboardWriter | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.clipboard,
): Promise<void> {
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    throw new Error('Clipboard access is unavailable in this browser context.');
  }
  await clipboard.writeText(value);
}
