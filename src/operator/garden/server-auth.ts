import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  acceptsHtml,
  hasBearerToken,
  hasCookieValue,
  isHtmxRequest,
} from '../../channels/http/auth.js';
import { sendRedirect, sendText } from '../../channels/http/primitives.js';

export function hasAdminRequestAuthCredentials(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  if (hasBearerToken(req, token)) return true;
  return hasCookieValue(req, 'psfn_token', token);
}

export function checkAdminRequestAuth(
  req: IncomingMessage,
  res: ServerResponse,
  token?: string,
): boolean {
  if (!token) return true;
  if (hasAdminRequestAuthCredentials(req, token)) {
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

export function checkAdminUpgradeAuth(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  return hasAdminRequestAuthCredentials(req, token);
}
