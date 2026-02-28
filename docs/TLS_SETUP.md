# TLS Setup Guide

This guide covers issuing TLS certificates for the PSFN gateway and LiteLLM
proxy, and configuring the runtime to trust custom certificate authorities.

## Quick Start

For local development with self-signed certificates:

```bash
# Generate self-signed cert for local LiteLLM proxy
./scripts/cert-setup.sh --self-signed --domain litellm.local

# Add to .env
GATEWAY_TLS_CA_PATH=./certs/litellm.local/ca.pem
```

For production with a real domain:

```bash
# Issue cert via Cloudflare DNS-01 challenge
CF_Token=your-cloudflare-api-token \
  ./scripts/cert-setup.sh --domain proxy.example.com --provider cloudflare
```

## Environment Variables

### Gateway TLS Trust

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_TLS_CA_PATH` | (none) | Path to a PEM-encoded CA certificate file. When set, the gateway process trusts this CA for all outbound HTTPS connections (LLM, embeddings, web fetch, etc.). Sets `NODE_EXTRA_CA_CERTS` at startup. |
| `GATEWAY_TLS_REJECT_UNAUTHORIZED` | `true` | When set to `false`, disables TLS certificate verification entirely. **DANGEROUS** -- only use for local development with self-signed certs. Sets `NODE_TLS_REJECT_UNAUTHORIZED=0`. |

### Web Fetch TLS (per-request)

| Variable | Default | Description |
|----------|---------|-------------|
| `FETCH_TLS_CA_CERT_PATHS` | (none) | Comma-separated paths to CA cert files used specifically for `web.fetch` requests. These are loaded per-request and appended to Node.js root certificates. Distinct from `GATEWAY_TLS_CA_PATH` which affects all connections. |

### Key Difference

- **`GATEWAY_TLS_CA_PATH`** affects the entire gateway process (LLM calls, embedding calls, everything). It sets `NODE_EXTRA_CA_CERTS` which Node.js applies globally.
- **`FETCH_TLS_CA_CERT_PATHS`** only affects the `web.fetch` gateway method. It injects the CA into individual `https.request()` calls.

For trusting a local LiteLLM proxy's certificate, use `GATEWAY_TLS_CA_PATH`.

## Certificate Issuance

### Using cert-setup.sh

The `scripts/cert-setup.sh` script automates certificate issuance using
[acme.sh](https://github.com/acmesh-official/acme.sh) for ACME DNS-01
challenges, or generates self-signed certificates for development.

#### Self-Signed (Development)

```bash
./scripts/cert-setup.sh --self-signed --domain litellm.local
```

This creates:
- `certs/litellm.local/ca.pem` -- CA certificate (trust this in the gateway)
- `certs/litellm.local/cert.pem` -- Server certificate (mount in LiteLLM)
- `certs/litellm.local/key.pem` -- Server private key (mount in LiteLLM)

#### ACME DNS-01 (Production)

Supported DNS providers:

| Provider | Required Environment Variables |
|----------|-------------------------------|
| Cloudflare | `CF_Token` (API token) or `CF_Key` + `CF_Email` (global key) |
| Route53 (AWS) | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` |
| DigitalOcean | `DO_API_KEY` |
| DuckDNS | `DuckDNS_Token` |

Example:

```bash
CF_Token=your-cloudflare-api-token \
  ./scripts/cert-setup.sh \
    --domain proxy.purrsephone.ai \
    --provider cloudflare \
    --email admin@purrsephone.ai
```

This issues a certificate via Let's Encrypt and installs it to
`certs/proxy.purrsephone.ai/`.

#### Certificate Status

Check expiry dates for all issued certificates:

```bash
./scripts/cert-setup.sh --status
```

### Manual Certificate Issuance

If you prefer not to use the script:

```bash
# Install acme.sh
curl https://get.acme.sh | sh

# Issue certificate (Cloudflare example)
export CF_Token="your-cloudflare-api-token"
acme.sh --issue --dns dns_cf -d proxy.example.com

# Copy to project
mkdir -p certs/proxy.example.com
acme.sh --install-cert -d proxy.example.com \
  --cert-file certs/proxy.example.com/cert.pem \
  --key-file certs/proxy.example.com/key.pem \
  --fullchain-file certs/proxy.example.com/fullchain.pem \
  --ca-file certs/proxy.example.com/ca.pem
```

## Configuring the LiteLLM Proxy

### With TLS (HTTPS)

Edit `proxy/docker-compose.yml` to mount certificates and enable SSL:

```yaml
services:
  litellm:
    # ... existing config ...
    ports:
      - "127.0.0.1:4000:4000"
    volumes:
      - ./litellm_config.yaml:/app/config.yaml:ro
      - ../certs/proxy.example.com/fullchain.pem:/certs/cert.pem:ro
      - ../certs/proxy.example.com/key.pem:/certs/key.pem:ro
    command:
      - "--config"
      - "/app/config.yaml"
      - "--port"
      - "4000"
      - "--ssl_certfile"
      - "/certs/cert.pem"
      - "--ssl_keyfile"
      - "/certs/key.pem"
    healthcheck:
      test: ["CMD", "curl", "-f", "https://localhost:4000/health", "--cacert", "/certs/cert.pem"]
      # ... intervals ...
```

Then update your `.env`:

```bash
# Point gateway LLM client at HTTPS proxy
LITELLM_BASE_URL=https://proxy.example.com:4000/v1

# Trust the CA that signed the proxy's certificate
GATEWAY_TLS_CA_PATH=./certs/proxy.example.com/ca.pem
```

### Without TLS (localhost only)

If the proxy runs on the same host and binds to `127.0.0.1`, plain HTTP is
acceptable since traffic never leaves the machine:

```bash
LITELLM_BASE_URL=http://localhost:4000/v1
```

No TLS configuration needed in this case.

## Renewal

### Automatic (acme.sh)

The `cert-setup.sh` script configures a daily cron job via acme.sh that
checks for certificates nearing expiry and renews them automatically.
Let's Encrypt certificates are valid for 90 days; acme.sh renews at 60 days.

Verify the cron entry exists:

```bash
crontab -l | grep acme
```

### Manual Renewal

```bash
acme.sh --renew -d proxy.example.com --force
```

After renewal, restart the LiteLLM proxy to pick up the new certificates:

```bash
cd proxy && docker compose restart litellm
```

### Self-Signed Renewal

Self-signed certificates from `cert-setup.sh --self-signed` are valid for
825 days. To regenerate:

```bash
./scripts/cert-setup.sh --self-signed --domain litellm.local
cd proxy && docker compose restart litellm
```

## Troubleshooting

### `UNABLE_TO_VERIFY_LEAF_SIGNATURE`

The gateway's Node.js process does not trust the certificate presented by the
LiteLLM proxy (or another HTTPS endpoint).

**Fix**: Set `GATEWAY_TLS_CA_PATH` to the CA certificate that signed the
server's certificate:

```bash
GATEWAY_TLS_CA_PATH=./certs/proxy.example.com/ca.pem
```

### `SELF_SIGNED_CERT_IN_CHAIN`

Same root cause as above. The server is using a self-signed certificate or a
certificate signed by a private CA.

**Fix**: Same as above -- point `GATEWAY_TLS_CA_PATH` to the CA cert.

### `CERT_HAS_EXPIRED`

The server's TLS certificate has expired.

**Fix**: Renew the certificate:

```bash
# ACME
acme.sh --renew -d proxy.example.com --force

# Self-signed
./scripts/cert-setup.sh --self-signed --domain litellm.local
```

Then restart the service using the certificate.

### `ERR_TLS_CERT_ALTNAME_INVALID`

The hostname you're connecting to does not match any Subject Alternative Name
(SAN) in the certificate.

**Fix**: Ensure the certificate was issued for the hostname in
`LITELLM_BASE_URL`. For self-signed certs, the `cert-setup.sh` script
includes `localhost` and `127.0.0.1` as SANs by default.

### Development: Skip Verification Entirely

As a last resort for local development:

```bash
GATEWAY_TLS_REJECT_UNAUTHORIZED=false
```

This disables all TLS verification. **Never use in production.** Fix the
certificate trust chain instead.

### Checking Certificate Details

```bash
# View certificate expiry and SANs
openssl x509 -in certs/proxy.example.com/cert.pem -text -noout | grep -A1 'Not After\|Subject Alternative'

# Test connection to proxy
openssl s_client -connect localhost:4000 -CAfile certs/proxy.example.com/ca.pem

# Check all certificates managed by cert-setup.sh
./scripts/cert-setup.sh --status
```

## File Layout

After running `cert-setup.sh`, the certificate directory looks like:

```
certs/
  proxy.example.com/
    ca.pem          # CA certificate (trust in gateway via GATEWAY_TLS_CA_PATH)
    cert.pem        # Server certificate
    key.pem         # Server private key
    fullchain.pem   # Full chain (cert + intermediates) — mount in LiteLLM
  litellm.local/    # Self-signed dev certs
    ca.pem
    ca-key.pem
    cert.pem
    key.pem
```

The `certs/` directory is gitignored. Never commit private keys to the repository.
