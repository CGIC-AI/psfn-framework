export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toIsoInstant(ms: number): string {
  return new Date(ms).toISOString();
}
