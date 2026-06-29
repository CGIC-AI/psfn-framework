import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from '../request-body.js';
import { parseRequestUrl } from '../request-url.js';
import { exactPath, paramWithSuffix, prefixedParamPath } from '../route-matchers.js';
import type { AdminContactsService } from '../services/types.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, toSanitizedMessage } from './shared.js';
import type { AdminApiRoute, AdminBodyReader } from './types.js';

export function buildAdminContactRoutes(options: {
  contactsService: AdminContactsService;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { contactsService, withBody } = options;

  const handleContactUpdate: AdminApiRoute['handle'] = (req, res, { id }) => {
    withBody(req, res, (body) => {
      const parsed = parseAdminJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      contactsService.updateContact(id, JSON.stringify(parsed.value)).then(
        (result) => {
          if (!result.ok) {
            sendJson(res, result.message === 'Contact not found' ? 404 : 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        },
        (error) => {
          sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to update contact') });
        },
      );
    });
  };

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/contacts'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/admin/contacts');
        contactsService.listContacts(url.searchParams).then(
          (data) => {
            sendJson(
              res,
              200,
              {
                ...data,
                profileMap: Object.fromEntries(data.profileMap.entries()),
                relatedChannelMap: Object.fromEntries(data.relatedChannelMap.entries()),
                socialGraphMap: Object.fromEntries(data.socialGraphMap.entries()),
              },
              ADMIN_DYNAMIC_JSON_HEADERS,
            );
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list contacts') });
          },
        );
      },
    },
    {
      method: 'POST',
      match: exactPath('/api/admin/contacts'),
      handle: (req, res) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          contactsService.createContact(JSON.stringify(parsed.value)).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, 400, { error: result.message });
                return;
              }
              sendJson(res, 201, result);
            },
            (error) => {
              sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to create contact') });
            },
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contacts/', 'id', '/merge'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          contactsService.mergeContacts(id, JSON.stringify(parsed.value)).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to merge contacts') });
            },
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contacts/', 'id', '/unlink'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          contactsService.unlinkChannelIdentity(id, JSON.stringify(parsed.value)).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to unlink contact identity') });
            },
          );
        });
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix('/api/admin/contacts/', 'id', '/conversation-channel/delete'),
      handle: (req, res, { id }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          contactsService.deleteConversationChannel(id, JSON.stringify(parsed.value)).then(
            (result) => {
              if (!result.ok) {
                sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
                return;
              }
              sendJson(res, 200, result);
            },
            (error) => {
              sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to delete conversation channel') });
            },
          );
        });
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (_req, res, { id }) => {
        contactsService.getContactDetail(id).then(
          (detail) => {
            if (!detail) {
              sendJson(res, 404, { error: 'Contact not found' });
              return;
            }
            sendJson(res, 200, detail, ADMIN_DYNAMIC_JSON_HEADERS);
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load contact detail') });
          },
        );
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (_req, res, { id }) => {
        contactsService.deleteContact(id).then(
          (result) => {
            if (!result.ok) {
              sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
              return;
            }
            sendJson(res, 200, result);
          },
          (error) => {
            sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to delete contact') });
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
