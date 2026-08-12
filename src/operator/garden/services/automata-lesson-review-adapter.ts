import type {
  GovernedAutomataLessonReviewPort,
  GovernedAutomataLessonReviewRequest,
} from '../../../faculties/automata/bus/lesson-proposal.js';
import type { GardenRequestContext } from '../garden-request-context.js';
import type { AdminSharedWorkspaceService } from './shared-workspace-service.js';

/**
 * Binds lesson proposals to the existing authenticated shared-workspace review
 * surface. Approval publishes the proposal artifact only; it cannot edit the
 * referenced prompt or tool definition.
 */
export function createGardenAutomataLessonReviewPort(options: {
  service: Pick<AdminSharedWorkspaceService, 'propose'>;
  context: GardenRequestContext | undefined;
}): GovernedAutomataLessonReviewPort {
  return {
    async propose(request: GovernedAutomataLessonReviewRequest) {
      const review = options.service.propose(options.context, request);
      if (review.status !== 'pending') {
        throw new Error('Governed shared-workspace proposal did not remain pending');
      }
      return { reviewId: review.reviewId, status: 'pending' };
    },
  };
}
