export interface EmbeddingConfig {
  ollamaUrl: string;
  model: string;
  dims: number;
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  ollamaUrl: 'http://your-ollama-host:11434',
  model: 'snowflake-arctic-embed2',
  dims: 1024,
};

export class EmbeddingProvider {
  private config: EmbeddingConfig;

  constructor(config?: Partial<EmbeddingConfig>) {
    this.config = { ...DEFAULT_EMBEDDING_CONFIG, ...config };
  }

  get dims(): number {
    return this.config.dims;
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const url = `${this.config.ollamaUrl}/api/embed`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embedding error ${response.status}: ${body}`);
    }

    const json = await response.json() as {
      embeddings: number[][];
    };

    return json.embeddings.map(e => new Float32Array(e));
  }
}
