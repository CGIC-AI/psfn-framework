export function truncateToolOutputContent(content: string, maxChars: number): string {
  return content.length > maxChars
    ? `${content.slice(0, maxChars)}\n... (truncated)`
    : content;
}
