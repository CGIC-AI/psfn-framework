import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http/primitives.js';
import { parseAdminJsonBody } from './request-body.js';
import { parseRequestUrl } from './request-url.js';
import {
  exactPath,
  paramWithSuffix,
  prefixedParamPath,
  type RouteMatcher,
  type RouteParams,
} from './route-matchers.js';
import type { AdminContactsService } from './services/types.js';

interface AdminApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

const ADMIN_DYNAMIC_JSON_HEADERS = { 'Cache-Control': 'no-store' } as const;

export function buildAdminContactRoutes(options: {
  contactsService: AdminContactsService;
  withBody: (req: IncomingMessage, res: ServerResponse, cb: (body: string) => void) => void;
}): AdminApiRoute[] {
  const { contactsService, withBody } = options;

  const handleContactUpdate = (req: IncomingMessage, res: ServerResponse, id: string): void => {
    withBody(req, res, (body) => {
      const parsed = parseAdminJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      const result = contactsService.updateContact(id, JSON.stringify(parsed.value));
      if (!result.ok) {
        sendJson(res, result.message === 'Contact not found' ? 404 : 400, { error: result.message });
        return;
      }
      sendJson(res, 200, result);
    });
  };

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/contacts'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/admin/contacts');
        const data = contactsService.listContacts(url.searchParams);
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
          const result = contactsService.createContact(JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, 400, { error: result.message });
            return;
          }
          sendJson(res, 201, result);
        });
      },
    },
    // Sub-path routes MUST come before generic prefixed param route for contacts
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
          const result = contactsService.mergeContacts(id, JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
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
          const result = contactsService.unlinkChannelIdentity(id, JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
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
          const deleteConversationChannel = (
            contactsService as AdminContactsService & {
              deleteConversationChannel?: (contactId: string, requestBody: string) => { ok: boolean; message: string };
            }
          ).deleteConversationChannel;
          if (typeof deleteConversationChannel !== 'function') {
            sendJson(res, 400, { error: 'Conversation channel deletion is not available' });
            return;
          }
          const result = deleteConversationChannel(id, JSON.stringify(parsed.value));
          if (!result.ok) {
            sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
            return;
          }
          sendJson(res, 200, result);
        });
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (_req, res, { id }) => {
        const detail = contactsService.getContactDetail(id);
        if (!detail) {
          sendJson(res, 404, { error: 'Contact not found' });
          return;
        }
        sendJson(res, 200, detail, ADMIN_DYNAMIC_JSON_HEADERS);
      },
    },
    {
      method: 'DELETE',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (_req, res, { id }) => {
        const result = contactsService.deleteContact(id);
        if (!result.ok) {
          sendJson(res, result.message.includes('not found') ? 404 : 400, { error: result.message });
          return;
        }
        sendJson(res, 200, result);
      },
    },
    {
      method: 'PUT',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (req, res, { id }) => {
        handleContactUpdate(req, res, id);
      },
    },
    {
      method: 'PATCH',
      match: prefixedParamPath('/api/admin/contacts/', 'id'),
      handle: (req, res, { id }) => {
        handleContactUpdate(req, res, id);
      },
    },
  ];
}
