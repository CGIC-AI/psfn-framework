// ── Vision review port contract (psfn-framework-kbdvl.1) ──
//
// Core-owned inbound vision-review port accepted by the turn loop
// (`imageVisionReviewer`, null when no reviewer is wired) and the embodiment
// continuity read it can return. Image generation and vision services live in
// the host `primitives/images/` layer.

export type ImageMode = 'create' | 'edit';

export type EmbodimentConsistencyVerdict = 'same_me' | 'drifted' | 'different_person';

/**
 * A companion-readable read on whether a new render still looks like the same
 * companion as the active reference. Charter 8.6: framing, not a score wall —
 * there is no numeric similarity value, and the review never auto-rejects.
 */
export interface ImageEmbodimentConsistency {
  verdict: EmbodimentConsistencyVerdict;
  /** Companion-facing framing derived from the verdict. */
  framing: string;
  /** The reviewer's short reason for the read. */
  note: string;
  referenceId: string;
  referenceDescription?: string;
}

export interface ImageVisionReview {
  question: string;
  summary: string;
  model: string;
  imageCount: number;
  embodiment?: ImageEmbodimentConsistency;
}

export interface ImageVisionReviewRequest {
  imageUrls: string[];
  imageLocalPaths?: string[];
  question?: string;
  prompt?: string;
  mode?: ImageMode;
  /** When true, compare the render(s) to the active reference for embodiment continuity. */
  compareToReference?: boolean;
}

export interface ImageVisionReviewer {
  analyze(input: ImageVisionReviewRequest): Promise<ImageVisionReview>;
}
