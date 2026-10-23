import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  acceptsHtml,
  hasBearerToken,
  isHtmxRequest,
} from '../../channels/backplane/http/auth.js';
import { sendRedirect, sendText } from '../../channels/backplane/http/primitives.js';
import type { GardenBrowserSessions } from './browser-sessions.js';

export function hasAdminRequestAuthCredentials(req: IncomingMessage, token?: string, sessions?: GardenBrowserSessions): boolean {
  if (!token) return true;
  if (hasBearerToken(req, token)) return true;
  return sessions?.isAuthenticated(req) ?? false;
}

export function checkAdminRequestAuth(
  req: IncomingMessage,
  res: ServerResponse,
  token?: string,
  sessions?: GardenBrowserSessions,
): boolean {
  if (!token) return true;
  if (hasAdminRequestAuthCredentials(req, token, sessions)) {
    return true;
  }

  // Redirect browser requests to login page, return 401 for API/htmx
  if (!isHtmxRequest(req) && acceptsHtml(req)) {
    sendRedirect(res, '/login');
  } else {
    sendText(res, 401, 'Unauthorized');
  }
  return false;
}

export function checkAdminUpgradeAuth(req: IncomingMessage, token?: string, sessions?: GardenBrowserSessions): boolean {
  if (!token) return true;
  return hasAdminRequestAuthCredentials(req, token, sessions);
}
