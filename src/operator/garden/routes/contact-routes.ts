import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from '../request-body.js';
import { parseRequestUrl } from '../request-url.js';
import { exactPath, paramWithSuffix, prefixedParamPath } from '../route-matchers.js';
import type { AdminContactsService } from '../services/types.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, sendInternalError } from './shared.js';
import type { AdminApiRoute, AdminBodyReader } from './types.js';

export function buildAdminContactRoutes(options: {
  contactsService: AdminContactsService;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { contactsService, withBody } = options;

  const handleContactUpdate: AdminApiRoute['handle'] = (req, res, { id }, context) => {
    if (!id) {
      sendJson(res, 400, { error: 'Contact id is required' });
      return;
    }
    withBody(req, res, (body) => {
      const parsed = parseAdminJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      contactsService.updateContact(id, JSON.stringify(parsed.value), context).then(
        (result) => {
          if (!result.ok) {
            const status = result.failureKind === 'authorization'
              ? 403
              : result.failureKind === 'immutability' || result.failureKind === 'conflict'
                ? 409
                : result.failureKind === 'not_found' || result.message === 'Contact not found'
                  ? 404
                  : result.failureKind === 'unavailable'
                    ? 503
                    : 400;
            sendJson(res, status, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        },
        (error) => {
          sendInternalError(res, error, 'Failed to update contact');
        },
      );
    });
  };

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/contacts'),
      handle: (req, res, _params, context) => {
        const url = parseRequestUrl(req, '/api/admin/contacts');
        contactsService.listContacts(url.searchParams, context).then(
          (data) => {
            sendJson(
              res,
              200,
              {
                ...data,
                recentContactShapeMap: Object.fromEntries(data.recentContactShapeMap.entries()),
                relatedChannelMap: Object.fromEntries(data.relatedChannelMap.entries()),
                socialGraphMap: Object.fromEntries(data.socialGraphMap.entries()),
                relationshipScoreMap: Object.fromEntries(data.relationshipScoreMap?.entries() ?? []),
              },
              ADMIN_DYNAMIC_JSON_HEADERS,
            );
          },
          (error) => {
            sendInternalError(res, error, 'Failed to list contacts');
          },
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/contacts'),
      handle: (req, res, _params, context) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          contactsService.createContact(JSON.stringify(parsed.value), context).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, 400, { error: result.message });
                return;
              }
              sendJson(res, 201, result);
            },
            (error) => {
              sendInternalError(res, error, 'Failed to create contact');
            },
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contacts/', 'id', '/merge'),
      handle: (req, res, { id }, context) => {
        if (!id) {
          sendJson(res, 400, { error: 'Contact id is required' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          contactsService.mergeContacts(id, JSON.stringify(parsed.value), context).then(
            (result) => {
              if (!result.ok) {
                const status = result.failureKind === 'authorization'
                  ? 403
                  : result.failureKind === 'conflict'
                    ? 409
                    : result.failureKind === 'not_found' || result.message.includes('not found')
                      ? 404
                      : 400;
                sendJson(res, status, { error: result.message });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendInternalError(res, error, 'Failed to merge contacts');
            },
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contacts/', 'id', '/channel-identity/transfer'),
      handle: (req, res, { id }, context) => {
        if (!id) {
          sendJson(res, 400, { error: 'Contact id is required' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          contactsService.transferChannelIdentity(id, JSON.stringify(parsed.value), context).then(
            (result) => {
              if (!result.ok) {
                const status = result.failureKind === 'authorization'
                  ? 403
                  : result.failureKind === 'conflict'
                    ? 409
                    : result.failureKind === 'not_found' || result.message.includes('not found')
                      ? 404
                      : 400;
                sendJson(res, status, { error: result.message });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendInternalError(res, error, 'Failed to transfer contact identity');
            },
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contacts/', 'id', '/unlink'),
      handle: (req, res, { id }, context) => {
        if (!id) {
          sendJson(res, 400, { error: 'Contact id is required' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          contactsService.unlinkChannelIdentity(id, JSON.stringify(parsed.value), context).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendInternalError(res, error, 'Failed to unlink contact identity');
            },
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contacts/', 'id', '/conversation-channel/delete'),
      handle: (req, res, { id }, context) => {
        if (!id) {
          sendJson(res, 400, { error: 'Contact id is required' });
          return;
        }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          contactsService.deleteConversationChannel(id, JSON.stringify(parsed.value), context).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendInternalError(res, error, 'Failed to delete conversation channel');
            },
          );
        });
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (_req, res, { id }, context) => {
        if (!id) {
          sendJson(res, 400, { error: 'Contact id is required' });
          return;
        }
        contactsService.getContactDetail(id, context).then(
          (detail) => {
            if (!detail) {
              sendJson(res, 404, { error: 'Contact not found' });
              return;
            }
            sendJson(res, 200, detail, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          (error) => {
            sendInternalError(res, error, 'Failed to load contact detail');
          },
        );
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (_req, res, { id }, context) => {
        if (!id) {
          sendJson(res, 400, { error: 'Contact id is required' });
          return;
        }
        contactsService.archiveContact(id, context).then(
          (result) => {
            if (!result.ok) {
              sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
              return;
            }
            sendJson(res, 200, result);
          },
          (error) => {
            sendInternalError(res, error, 'Failed to archive contact');
          },
        );
      },
    },
    {
      method: 'PUT',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: handleContactUpdate,
    },
    {
      method: 'PATCH',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: handleContactUpdate,
    },
  ];
}
