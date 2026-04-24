import type { PurrMemory } from '../types.js';
import type { ProactiveWeightedMemory } from './types.js';

export function computeProactiveRecallWeight(memory: PurrMemory): number {
  const now = Date.now();
  const lastAccessed = Number.isFinite(memory.lastAccessed) ? memory.lastAccessed : memory.extractedAt;
  const ageMs = Math.max(0, now - lastAccessed);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyWeight = 1 / (1 + ageDays / 14);
  const emotionalSignificance = 1 + Math.abs(memory.emotionalValence) * 2;
  const salienceWeight = Math.max(0.1, memory.salience);
  const importanceWeight = Math.max(0.1, memory.importance);

  return recencyWeight * emotionalSignificance * salienceWeight * importanceWeight;
}

export function selectWeightedMemory(weighted: ProactiveWeightedMemory[]): PurrMemory | undefined {
  if (weighted.length === 0) return undefined;
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return undefined;

  let draw = Math.random() * totalWeight;
  for (const item of weighted) {
    draw -= item.weight;
    if (draw <= 0) return item.memory;
  }
  return weighted[weighted.length - 1]?.memory;
}
