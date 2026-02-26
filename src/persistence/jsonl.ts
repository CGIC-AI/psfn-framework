import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendJsonLine(path: string, entry: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf-8');
}
