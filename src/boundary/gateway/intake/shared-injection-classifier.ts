// One L1.5 injection classifier per gateway process (psfn-framework-3mbpi).
//
// The model is identical for every companion and the classifier holds no
// companion state, so a fleet gateway loads it once: every companion's
// screening composition acquires this shared instance (and its single worker
// pool, sized by intake-policy.json injectionClassifier.worker.poolSize)
// instead of loading its own ~1.4 GiB copy. Companion attribution, audit and
// quarantine stay in each composition; only inference is shared.

import type { InjectionClassifier } from './injection-classifier.js';

export interface SharedInjectionClassifier {
  /**
   * The process classifier, created by the first caller's `create`. Every
   * caller must name the same model directory.
   */
  acquire(input: {
    modelDir: string;
    create: () => Promise<InjectionClassifier>;
  }): Promise<InjectionClassifier>;
  /** Disposes the classifier (and its worker pool) once, at process teardown. */
  dispose(): Promise<void>;
}

export function createSharedInjectionClassifier(): SharedInjectionClassifier {
  let loaded: { modelDir: string; classifier: Promise<InjectionClassifier> } | null = null;
  return {
    acquire(input) {
      if (loaded) {
        if (loaded.modelDir !== input.modelDir) {
          return Promise.reject(new Error(
            `Shared injection classifier is loaded from ${loaded.modelDir}, not ${input.modelDir}`,
          ));
        }
        return loaded.classifier;
      }
      loaded = { modelDir: input.modelDir, classifier: input.create() };
      return loaded.classifier;
    },
    async dispose() {
      if (!loaded) return;
      const pending = loaded.classifier;
      loaded = null;
      const classifier = await pending.catch(() => null);
      await classifier?.dispose();
    },
  };
}
