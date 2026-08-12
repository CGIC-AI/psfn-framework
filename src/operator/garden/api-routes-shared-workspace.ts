import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../channels/backplane/http/primitives.js';
import { isRecord } from '../../shared/utils/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { exactPath, paramWithSuffix } from './route-matchers.js';
import { parseAdminJsonBody } from './request-body.js';
import { parseRequestUrl } from './request-url.js';
import type { AdminApiRoute } from './routes/types.js';
import {
  SharedWorkspaceAuthenticationError,
  type AdminSharedWorkspaceService,
} from './services/shared-workspace-service.js';
import { AutomataLessonProposalService } from '../../faculties/automata/bus/lesson-proposal.js';
import { createGardenAutomataLessonReviewPort } from './services/automata-lesson-review-adapter.js';
import type { AdminAutomataService } from './services/automata-service.js';

function sendActionError(res: ServerResponse, error: unknown): void {
  sendJson(res, error instanceof SharedWorkspaceAuthenticationError ? 401 : 400, {
    error: toErrorMessage(error),
  });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every(key => allowedSet.has(key));
}

interface AutomataLessonProposalAction {
  kind: 'automata_lesson';
  groupId: string;
  target: { kind: 'instruction' | 'tool'; id: string; baseRevision: string };
  before: string;
  after: string;
}

function parseAutomataLessonProposalAction(value: Record<string, unknown>): AutomataLessonProposalAction | null {
  if (!hasOnlyKeys(value, ['kind', 'groupId', 'target', 'before', 'after'])
    || value.kind !== 'automata_lesson'
    || typeof value.groupId !== 'string'
    || !isRecord(value.target)
    || !hasOnlyKeys(value.target, ['kind', 'id', 'baseRevision'])
    || (value.target.kind !== 'instruction' && value.target.kind !== 'tool')
    || typeof value.target.id !== 'string'
    || typeof value.target.baseRevision !== 'string'
    || typeof value.before !== 'string'
    || typeof value.after !== 'string') {
    return null;
  }
  return {
    kind: value.kind,
    groupId: value.groupId,
    target: {
      kind: value.target.kind,
      id: value.target.id,
      baseRevision: value.target.baseRevision,
    },
    before: value.before,
    after: value.after,
  };
}

export function buildAdminSharedWorkspaceRoutes(options: {
  service: AdminSharedWorkspaceService;
  automataService?: AdminAutomataService | null;
  withBody: (req: IncomingMessage, res: ServerResponse, cb: (body: string) => void) => void;
}): AdminApiRoute[] {
  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/shared-workspace'),
      handle: (_req, res) => {
        try {
          sendJson(res, 200, options.service.getSnapshot(), { 'Cache-Control': 'no-store' });
        } catch (error) {
          sendJson(res, 500, { error: toErrorMessage(error) });
        }
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/shared-workspace/artifact'),
      handle: (req, res) => {
        const artifactPath = parseRequestUrl(req, '/api/admin/shared-workspace/artifact')
          .searchParams.get('path');
        if (!artifactPath) {
          sendJson(res, 400, { error: 'path query parameter is required' });
          return;
        }
        try {
          sendJson(res, 200, options.service.readArtifact(artifactPath), { 'Cache-Control': 'no-store' });
        } catch (error) {
          sendJson(res, 400, { error: toErrorMessage(error) });
        }
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/shared-workspace/proposals'),
      handle: (req, res, _params, context) => options.withBody(req, res, (body) => {
        const parsed = parseAdminJsonBody(body);
        if (!parsed.ok || !isRecord(parsed.value)) {
          sendJson(res, 400, { error: parsed.ok ? 'Expected JSON object body' : parsed.error });
          return;
        }
        const value = parsed.value;
        if (value.kind === 'automata_lesson') {
          const action = parseAutomataLessonProposalAction(value);
          if (!action) {
            sendJson(res, 400, { error: 'Invalid Automata lesson proposal action' });
            return;
          }
          if (!options.automataService) {
            sendJson(res, 503, { error: 'Automata lesson projection unavailable' });
            return;
          }
          options.automataService.getSnapshot().then(async snapshot => {
            const group = snapshot.lessons.groups.find(candidate => candidate.groupId === action.groupId);
            if (!group) throw new Error('Automata lesson group is not current or visible');
            const proposalService = new AutomataLessonProposalService({
              review: createGardenAutomataLessonReviewPort({
                service: options.service,
                context,
              }),
              policy: {
                maxChangeChars: body.length,
                maxSourceIds: group.sourceFindingIds.length,
              },
            });
            const prepared = proposalService.prepare({
              group,
              target: action.target,
              before: action.before,
              after: action.after,
              rationaleCode: 'recurrent-supported-finding',
            });
            return await proposalService.submitForReview(prepared);
          }).then(
            receipt => sendJson(res, 201, receipt),
            error => sendActionError(res, error),
          );
          return;
        }
        if (!hasOnlyKeys(value, ['artifactPath', 'content', 'mediaType', 'provenance'])
          || typeof value.artifactPath !== 'string'
          || typeof value.content !== 'string'
          || (value.mediaType !== 'text/markdown'
            && value.mediaType !== 'text/plain'
            && value.mediaType !== 'application/json')
          || typeof value.provenance !== 'string') {
          sendJson(res, 400, {
            error: 'artifactPath, content, mediaType, and provenance are required; identity claims are forbidden',
          });
          return;
        }
        if (value.artifactPath.startsWith('automata/lesson-proposals/')
          || value.provenance.startsWith('automata-lesson:')) {
          sendJson(res, 400, {
            error: 'Automata lesson artifacts must use the server-validated proposal action',
          });
          return;
        }
        try {
          sendJson(res, 201, options.service.propose(context, {
            artifactPath: value.artifactPath,
            content: value.content,
            mediaType: value.mediaType,
            provenance: value.provenance,
          }));
        } catch (error) {
          sendActionError(res, error);
        }
      }),
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/shared-workspace/reviews/', 'reviewId', '/cogsec'),
      handle: (req, res, { reviewId }, context) => {
        if (!reviewId) {
          sendJson(res, 400, { error: 'reviewId is required' });
          return;
        }
        options.withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok || !isRecord(parsed.value)) {
            sendJson(res, 400, { error: parsed.ok ? 'Expected JSON object body' : parsed.error });
            return;
          }
          const value = parsed.value;
          if (!hasOnlyKeys(value, ['decision', 'note'])
            || (value.decision !== 'approved' && value.decision !== 'rejected')
            || (value.note !== undefined && typeof value.note !== 'string')) {
            sendJson(res, 400, {
              error: 'decision must be approved or rejected; note must be a string; identity claims are forbidden',
            });
            return;
          }
          try {
            sendJson(res, 201, options.service.recordCogSecDecision(
              context,
              {
                reviewId,
                decision: value.decision,
                ...(value.note ? { note: value.note } : {}),
              },
            ));
          } catch (error) {
            sendActionError(res, error);
          }
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/shared-workspace/reviews/', 'reviewId', '/decision'),
      handle: (req, res, { reviewId }, context) => {
        if (!reviewId) {
          sendJson(res, 400, { error: 'reviewId is required' });
          return;
        }
        options.withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok || !isRecord(parsed.value)) {
            sendJson(res, 400, { error: parsed.ok ? 'Expected JSON object body' : parsed.error });
            return;
          }
          const value = parsed.value;
          if (!hasOnlyKeys(value, ['decision', 'note'])
            || (value.decision !== 'approve' && value.decision !== 'reject')
            || (value.note !== undefined && typeof value.note !== 'string')) {
            sendJson(res, 400, {
              error: 'decision must be approve or reject; note must be a string; identity claims are forbidden',
            });
            return;
          }
          try {
            sendJson(res, 200, options.service.review(
              context,
              {
                reviewId,
                decision: value.decision,
                ...(value.note ? { note: value.note } : {}),
              },
            ));
          } catch (error) {
            sendActionError(res, error);
          }
        });
      },
    },
  ];
}
