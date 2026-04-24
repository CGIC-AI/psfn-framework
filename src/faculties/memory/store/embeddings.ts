import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export function loadSqliteVecExtension(db: Database.Database): void {
  sqliteVec.load(db);
}

export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

export function validateEmbeddingDimensions(
  embedding: Float32Array,
  expectedDims: number,
  operation: string,
): void {
  if (embedding.length !== expectedDims) {
    throw new Error(`SQLite memory embedding ${operation} dimension mismatch: expected ${expectedDims}, got ${embedding.length}`);
  }
}

export function l2DistanceToCosineSimilarity(distance: number): number {
  return 1 - (distance * distance) / 2;
}
