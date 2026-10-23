import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { getCookieValue, hasBearerToken } from '../../channels/backplane/http/auth.js';
import { sendJson, sendRedirect, sendText } from '../../channels/backplane/http/primitives.js';
import { timingSafeStringEqual } from '../../shared/utils/secret-compare.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { sendGardenLoginPage } from './auth-pages.js';
import { gardenBrowserCsp } from './browser-headers.js';
import { matchesGardenProxyPeer } from './browser-proxy-policy.js';

interface BrowserSession {
  csrf: string;
  authenticated: boolean;
  expiresAt: number;
  timer: NodeJS.Timeout;
  sockets: Set<Duplex>;
}

export interface GardenBrowserTransport {
  publicOrigin?: string;
  trustedProxyAddresses?: readonly string[];
}

// Security bounds, independent of mutable companion settings. Sessions never
// renew on reads; login is the explicit rotation and reauthentication ceremony.
const SESSION_SECONDS = 900;
const CHALLENGE_SECONDS = 300;
const SESSION_CAPACITY = 1024;
const SESSION_COOKIE = '__Host-psfn_session';
const CSRF_COOKIE = '__Host-psfn_csrf';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function opaque(): string { return randomBytes(32).toString('base64url'); }

function cookie(name: string, value: string, seconds: number, httpOnly: boolean): string {
  return `${name}=${value}; Path=/; Secure;${httpOnly ? ' HttpOnly;' : ''} SameSite=Strict; Max-Age=${seconds}; Expires=${new Date(Date.now() + seconds * 1000).toUTCString()}`;
}

function appendCookies(res: ServerResponse, values: string[]): void {
  const existing = res.getHeader('Set-Cookie');
  const previous = Array.isArray(existing) ? existing : (existing ? [String(existing)] : []);
  res.setHeader('Set-Cookie', [...previous, ...values]);
}

/**
 * Standalone browser authority lives only in this listener's process. The chart
 * requires one replica because challenges and revocation are not shared.
 */
export class GardenBrowserSessions {
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(private readonly options: GardenBrowserTransport & { token?: string }) {}

  close(): void {
    for (const key of this.sessions.keys()) this.revoke(key);
  }

  checkHttpSecurity(req: IncomingMessage, res: ServerResponse): boolean {
    res.setHeader('Content-Security-Policy', gardenBrowserCsp('', this.options.publicOrigin));
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (this.secureRequest(req)) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      if (getCookieValue(req, 'psfn_token') !== null) appendCookies(res, [cookie('psfn_token', '', 0, true)]);
    }
    // The unauthenticated health probe carries no browser authority.
    if (req.url === '/health' && req.method === 'GET') return true;
    if (this.options.publicOrigin && !this.secureRequest(req)) {
      sendText(res, 403, 'Invalid Garden proxy transport or Host');
      return false;
    }
    if (!this.options.publicOrigin && !this.localHost(req)) {
      sendText(res, 403, 'Invalid Garden Host');
      return false;
    }
    if (req.headers.origin !== undefined && !this.exactOrigin(req)) {
      sendText(res, 403, 'Invalid Garden Origin');
      return false;
    }
    this.normalizeForwardedHeaders(req);
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || req.url === '/login') return true;
    if (!this.options.token || hasBearerToken(req, this.options.token)) return true;
    const session = this.lookup(req);
    const proof = req.headers['x-csrf-token'];
    if (!this.exactOrigin(req) || !session?.authenticated || typeof proof !== 'string'
      || !timingSafeStringEqual(proof, session.csrf)) {
      sendText(res, 403, 'Invalid Garden CSRF proof');
      return false;
    }
    return true;
  }

  handleLoginPage(req: IncomingMessage, res: ServerResponse, config: SubstrateConfig): void {
    if (!this.secureRequest(req)) {
      sendText(res, 503, 'Browser login requires the configured HTTPS proxy');
      return;
    }
    // Loading the login page must not invalidate an authenticated session.
    const existing = this.lookup(req);
    const session = existing?.authenticated ? existing : this.issue(req, res, false);
    if (!session) return;
    sendGardenLoginPage(res, config, undefined, 200, session.csrf);
  }

  handleLogin(req: IncomingMessage, res: ServerResponse, body: string, config: SubstrateConfig): void {
    const params = new URLSearchParams(body);
    const session = this.lookup(req);
    if (!this.secureRequest(req) || !this.exactOrigin(req) || !session
      || !timingSafeStringEqual(params.get('csrf') ?? '', session.csrf)) {
      sendText(res, 403, 'Invalid browser login proof');
      return;
    }
    if (!this.options.token || !timingSafeStringEqual(params.get('token') ?? '', this.options.token)) {
      sendGardenLoginPage(res, config, 'Invalid token', 401, session.csrf);
      return;
    }
    if (!this.issue(req, res, true)) return;
    sendRedirect(res, '/');
  }

  handleLogout(req: IncomingMessage, res: ServerResponse): void {
    const id = getCookieValue(req, SESSION_COOKIE);
    if (id) this.revoke(digest(id));
    appendCookies(res, [cookie(SESSION_COOKIE, '', 0, true), cookie(CSRF_COOKIE, '', 0, false)]);
    sendJson(res, 200, { ok: true });
  }

  isAuthenticated(req: IncomingMessage): boolean {
    if (!this.options.token) return true;
    if (hasBearerToken(req, this.options.token)) return true;
    return this.secureRequest(req) && this.lookup(req)?.authenticated === true;
  }

  checkUpgradeSecurity(req: IncomingMessage): boolean {
    if (this.options.publicOrigin && !this.secureRequest(req)) return false;
    if (!this.options.publicOrigin && !this.localHost(req)) return false;
    if (req.headers.origin !== undefined && !this.exactOrigin(req)) return false;
    this.normalizeForwardedHeaders(req);
    if (this.options.token && hasBearerToken(req, this.options.token)) return true;
    if (!this.options.token) return req.headers.origin === undefined || this.exactOrigin(req);
    const session = this.lookup(req);
    if (!this.secureRequest(req) || !this.exactOrigin(req) || !session?.authenticated) return false;
    session.sockets.add(req.socket);
    req.socket.once('close', () => session.sockets.delete(req.socket));
    return true;
  }

  private secureRequest(req: IncomingMessage): boolean {
    const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    return Boolean(this.options.publicOrigin && peer
      && this.options.trustedProxyAddresses
      && matchesGardenProxyPeer(peer, this.options.trustedProxyAddresses)
      && req.headers['x-forwarded-proto'] === 'https'
      && req.headers.host === new URL(this.options.publicOrigin).host);
  }

  private normalizeForwardedHeaders(req: IncomingMessage): void {
    delete req.headers.forwarded;
    delete req.headers['x-forwarded-for'];
    req.headers['x-forwarded-host'] = req.headers.host;
    req.headers['x-forwarded-proto'] = this.options.publicOrigin ? 'https' : 'http';
  }

  private exactOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      const parsed = new URL(origin);
      const expected = this.options.publicOrigin ?? (this.localHost(req) ? `http://${req.headers.host}` : undefined);
      return parsed.origin === origin && parsed.origin === expected;
    } catch { return false; }
  }

  private localHost(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host) return false;
    const address = req.socket.localAddress?.replace(/^::ffff:/, '');
    const ipHost = address?.includes(':') ? `[${address}]` : address;
    return host === `${ipHost}:${req.socket.localPort}` || host === `localhost:${req.socket.localPort}`;
  }

  private lookup(req: IncomingMessage): BrowserSession | undefined {
    const id = getCookieValue(req, SESSION_COOKIE);
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
    const key = digest(id);
    const session = this.sessions.get(key);
    if (session && session.expiresAt <= Date.now()) {
      this.revoke(key);
      return undefined;
    }
    return session;
  }

  private issue(req: IncomingMessage, res: ServerResponse, authenticated: boolean): BrowserSession | undefined {
    const previous = getCookieValue(req, SESSION_COOKIE);
    if (previous) this.revoke(digest(previous));
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= Date.now()) this.revoke(key);
    }
    if (this.sessions.size >= SESSION_CAPACITY) {
      sendText(res, 503, 'Garden session capacity reached; retry after challenges expire');
      return undefined;
    }
    const id = opaque();
    const key = digest(id);
    const seconds = authenticated ? SESSION_SECONDS : CHALLENGE_SECONDS;
    const timer = setTimeout(() => this.revoke(key), seconds * 1000);
    timer.unref();
    const session: BrowserSession = {
      csrf: opaque(), authenticated, expiresAt: Date.now() + seconds * 1000, timer, sockets: new Set(),
    };
    this.sessions.set(key, session);
    appendCookies(res, [cookie(SESSION_COOKIE, id, seconds, true), cookie(CSRF_COOKIE, session.csrf, seconds, false)]);
    return session;
  }

  private revoke(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    clearTimeout(session.timer);
    for (const socket of session.sockets) socket.destroy();
  }
}
