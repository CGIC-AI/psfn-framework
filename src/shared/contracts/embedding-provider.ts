export interface EmbeddingProviderPort {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dims: number;
}
