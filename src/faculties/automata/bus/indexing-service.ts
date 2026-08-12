import type {
  AutomataBusCanonicalFinding,
  AutomataBusEmbeddingIdentity,
  AutomataBusEmbeddingPort,
  AutomataBusIndexHealthPort,
  AutomataBusIndexLagStage,
  AutomataBusVectorIndexPort,
} from './query-ports.js';

export type AutomataBusIndexingResult =
  | {
      status: 'indexed';
      eventId: string;
      modelIdentity: AutomataBusEmbeddingIdentity;
    }
  | {
      status: 'lagging';
      eventId: string;
      stage: AutomataBusIndexLagStage;
      modelIdentity: AutomataBusEmbeddingIdentity;
    };

interface AutomataBusIndexingServiceOptions {
  embeddings: AutomataBusEmbeddingPort;
  vector: AutomataBusVectorIndexPort;
  health: AutomataBusIndexHealthPort;
}

function sameModel(
  left: AutomataBusEmbeddingIdentity,
  right: AutomataBusEmbeddingIdentity,
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.dimensions === right.dimensions;
}

export class AutomataBusIndexingService {
  private readonly embeddings: AutomataBusEmbeddingPort;
  private readonly vector: AutomataBusVectorIndexPort;
  private readonly health: AutomataBusIndexHealthPort;

  constructor(options: AutomataBusIndexingServiceOptions) {
    this.embeddings = options.embeddings;
    this.vector = options.vector;
    this.health = options.health;
  }

  private async lag(
    finding: AutomataBusCanonicalFinding,
    stage: AutomataBusIndexLagStage,
  ): Promise<AutomataBusIndexingResult> {
    await this.health.markLagging({
      eventId: finding.eventId,
      companionId: finding.companionId,
      stage,
      modelIdentity: this.embeddings.identity,
    }).catch(() => undefined);
    return {
      status: 'lagging',
      eventId: finding.eventId,
      stage,
      modelIdentity: this.embeddings.identity,
    };
  }

  /**
   * Index only after the canonical finding transaction commits. Failures are
   * converted to explicit lag so append/current-state truth stays available.
   */
  async indexCurrentFinding(
    finding: AutomataBusCanonicalFinding,
  ): Promise<AutomataBusIndexingResult> {
    let state;
    try {
      state = await this.vector.readState();
    } catch {
      return await this.lag(finding, 'index-state');
    }
    if (
      state.modelIdentity !== null
      && !sameModel(state.modelIdentity, this.embeddings.identity)
    ) {
      return await this.lag(finding, 'model-identity');
    }

    let embedding: Float32Array;
    try {
      embedding = await this.embeddings.embed(finding.claim);
      if (embedding.length !== this.embeddings.identity.dimensions) {
        return await this.lag(finding, 'embedding');
      }
    } catch {
      return await this.lag(finding, 'embedding');
    }
    try {
      await this.vector.upsert({
        ...finding,
        embedding,
        modelIdentity: this.embeddings.identity,
      });
    } catch {
      return await this.lag(finding, 'vector');
    }
    await this.health.markIndexed({
      eventId: finding.eventId,
      companionId: finding.companionId,
      modelIdentity: this.embeddings.identity,
    }).catch(() => undefined);
    return {
      status: 'indexed',
      eventId: finding.eventId,
      modelIdentity: this.embeddings.identity,
    };
  }
}
