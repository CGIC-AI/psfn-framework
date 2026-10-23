# Standalone Garden browser sessions

Standalone Garden browser login requires HTTPS through an explicitly trusted
TLS-terminating proxy. Set `ADMIN_PUBLIC_ORIGIN` to the exact normalized HTTPS
origin, without a trailing slash, path, credentials, or default `:443` suffix.
Set `ADMIN_TRUSTED_PROXY_ADDRESSES` to comma-separated literal IP addresses or
CIDR networks belonging to the immediate proxy peers. Wildcards, DNS names,
unspecified addresses, and `/0` networks reject startup. Use a dedicated proxy
network and restrict access to the Garden listener to those peers.

The proxy must validate its browser TLS certificate, preserve the public `Host`,
and overwrite `X-Forwarded-Proto` with the single value `https`. Configure it to
redirect or reject public HTTP before forwarding requests, including WebSocket
upgrades. Garden checks the actual socket peer against the configured allowlist;
`Forwarded`, `X-Forwarded-For`, and `X-Forwarded-Host` never confer trust. Only
`GET /health` remains available outside the browser transport contract.

For example, a local TLS proxy can forward `https://garden.example.test` to a
loopback Garden listener configured with:

```dotenv
ADMIN_HOST=127.0.0.1
ADMIN_PUBLIC_ORIGIN=https://garden.example.test
ADMIN_TRUSTED_PROXY_ADDRESSES=127.0.0.1
```

This example does not provision DNS, a proxy, or certificates. The proxy-to-Garden
HTTP hop is trusted infrastructure: isolate it on loopback or a protected private
network. Do not give general workloads membership in an allowed proxy network.
Both standalone listeners refuse non-loopback startup without the full contract.
Loopback without the contract supports bearer automation; browser login returns
503. Explicit unauthenticated development remains restricted to loopback.

`GET /login` creates a five-minute login challenge. Its form proof and exact
`Origin` must accompany `POST /login`. A valid `ADMIN_TOKEN` exchanges that
challenge for a random 256-bit opaque session, with a separate CSRF proof.
Only digests of session identifiers and session metadata stay in process memory.
The raw admin token is never put in a browser cookie or forwarded to an agent.
Returning browsers' previous raw-token cookies are expired over the secure proxy.

`__Host-psfn_session` is `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, and
expires after fifteen minutes. `__Host-psfn_csrf` has the same host, transport,
and expiry restrictions but is script-readable so the UI can send
`X-CSRF-Token` on unsafe same-origin HTTP requests. Cookie authentication requires
an exact public `Host`; unsafe requests also require the exact `Origin` and CSRF
proof. Browser WebSockets require the exact `Origin` and `Host` before admission.
Sibling origins, other ports, absent or `null` Origins, and forwarded-header
spoofing do not substitute for those checks.

Reads never extend a session. Signing in again rotates its identifier and CSRF
proof and invalidates the previous session and its WebSockets. Logout invalidates
server authority immediately, closes its WebSockets, and clears both cookies.
Expiry also closes WebSockets. Restarting Garden revokes all sessions. Rotating
`ADMIN_TOKEN` requires restarting the process, which also revokes all sessions.
The store holds at most 1,024 challenges and sessions; when full, new challenges
return 503 until entries expire. A challenge flood cannot evict active operators.

Browser responses include CSP, frame denial, MIME sniffing prevention, referrer
suppression, and HSTS on validated HTTPS proxy requests. The built SPA's inline
bootstrap is authorized by a content hash; arbitrary inline scripts stay blocked.
Google Fonts, same-origin API requests, and the exact WSS origin remain allowed.
Sensitive responses and the SPA shell use `no-store`.

Automation uses `Authorization: Bearer <ADMIN_TOKEN>` and does not create browser
cookies or perform the login ceremony. Browser-authored requests carrying an
Origin still undergo exact Origin checks. Compose, local, and Helm doctors use
this bearer path; when `ADMIN_PUBLIC_ORIGIN` is configured they contact that HTTPS
origin. The native curl helper keeps credentials on stdin, and disables certificate
verification only for its explicit loopback cluster endpoint. Fleet-auth Garden
continues to use its separate gateway mTLS/SPIFFE and request-capability paths.

For Helm, standalone rendering requires `gardenBrowser.publicOrigin` and
`gardenBrowser.trustedProxyAddresses`. When `ingress.garden.enabled=true`, enable
`ingress.garden.tls.enabled`, provide an existing `ingress.garden.tls.secretName`,
and make the ingress host match the public origin exactly. The public lifecycle
maps the environment variables above to these values; native ingress additionally
uses `ADMIN_TLS_SECRET_NAME`. Compose passes the same origin and peer allowlist.
No certificate or live configuration is created by these settings.
