import type { PostTurnActionCandidate } from '../shared/contracts/runtime.js';

export interface PostTurnSignalPass<Context> {
  name: string;
  infer: (context: Context) => PostTurnActionCandidate[] | Promise<PostTurnActionCandidate[]>;
}

export interface PostTurnAppraisalOptions<Context> {
  onPassError?: (passName: string, error: unknown, context: Context) => void;
}

export function createSignalWisePostTurnAppraiser<Context>(
  passes: ReadonlyArray<PostTurnSignalPass<Context>>,
  options: PostTurnAppraisalOptions<Context> = {},
): (context: Context) => Promise<PostTurnActionCandidate[]> {
  return async (context: Context): Promise<PostTurnActionCandidate[]> => {
    const inferred: PostTurnActionCandidate[] = [];
    const seenDedupeKeys = new Set<string>();

    for (const pass of passes) {
      let candidates: PostTurnActionCandidate[] = [];
      try {
        candidates = await pass.infer(context);
      } catch (error) {
        options.onPassError?.(pass.name, error, context);
        continue;
      }

      for (const candidate of candidates) {
        if (typeof candidate.kind !== 'string') {
          continue;
        }

        const dedupeKey = typeof candidate.dedupeKey === 'string'
          ? candidate.dedupeKey.trim()
          : '';
        if (dedupeKey) {
          if (seenDedupeKeys.has(dedupeKey)) {
            continue;
          }
          seenDedupeKeys.add(dedupeKey);
        }

        inferred.push({
          ...candidate,
          ...(dedupeKey ? { dedupeKey } : {}),
        });
      }
    }

    return inferred;
  };
}
