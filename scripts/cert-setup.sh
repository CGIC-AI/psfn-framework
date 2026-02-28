#!/usr/bin/env bash
# ── PSFN Certificate Setup ──
# Automates TLS certificate issuance via ACME DNS-01 challenge for the
# LiteLLM proxy and gateway. Uses acme.sh (preferred) or certbot.
#
# Usage:
#   ./scripts/cert-setup.sh --domain proxy.example.com --provider cloudflare
#   ./scripts/cert-setup.sh --domain proxy.example.com --provider route53
#   ./scripts/cert-setup.sh --self-signed --domain proxy.local
#   ./scripts/cert-setup.sh --status
#
# Environment variables (set before running or in .env):
#   DNS provider credentials — see provider section below.
#
# Output:
#   Certificates are placed in ./certs/<domain>/
#   Prints env vars to set in your .env for gateway TLS config.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CERT_DIR="${ROOT_DIR}/certs"

# ── Defaults ──
DOMAIN=""
DNS_PROVIDER=""
SELF_SIGNED=false
STATUS_ONLY=false
CERT_EMAIL="${CERT_EMAIL:-}"
ACME_SERVER="${ACME_SERVER:-}" # e.g. letsencrypt, zerossl, buypass

usage() {
  cat <<'EOF'
PSFN Certificate Setup — ACME DNS-01 automation

Usage:
  cert-setup.sh --domain <fqdn> --provider <dns-provider>
  cert-setup.sh --self-signed --domain <hostname>
  cert-setup.sh --status
  cert-setup.sh --help

Options:
  --domain, -d       Fully qualified domain name for the certificate
  --provider, -p     DNS provider for ACME DNS-01 challenge:
                       cloudflare  — requires CF_Token or CF_Key+CF_Email
                       route53     — requires AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY
                       digitalocean — requires DO_API_KEY
                       duckdns     — requires DuckDNS_Token
  --self-signed      Generate a self-signed certificate (no ACME, no renewal)
  --email, -e        Email for ACME account registration
  --server           ACME server (letsencrypt, zerossl, buypass) — default: letsencrypt
  --status           Show current certificate status and expiry dates
  --help, -h         Show this help

Examples:
  # Issue cert via Cloudflare DNS:
  CF_Token=xxx ./scripts/cert-setup.sh -d proxy.purrsephone.ai -p cloudflare

  # Issue cert via AWS Route53:
  AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy \
    ./scripts/cert-setup.sh -d proxy.purrsephone.ai -p route53

  # Self-signed for local development:
  ./scripts/cert-setup.sh --self-signed -d litellm.local

After issuing, add to your .env:
  GATEWAY_TLS_CA_PATH=./certs/<domain>/ca.pem
  # For LiteLLM proxy, mount cert/key into docker-compose — see docs/TLS_SETUP.md
EOF
  exit 0
}

# ── Parse arguments ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain|-d) DOMAIN="$2"; shift 2 ;;
    --provider|-p) DNS_PROVIDER="$2"; shift 2 ;;
    --self-signed) SELF_SIGNED=true; shift ;;
    --email|-e) CERT_EMAIL="$2"; shift 2 ;;
    --server) ACME_SERVER="$2"; shift 2 ;;
    --status) STATUS_ONLY=true; shift ;;
    --help|-h) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# ── Status mode ──
if [ "$STATUS_ONLY" = true ]; then
  echo "=== PSFN Certificate Status ==="
  if [ ! -d "$CERT_DIR" ]; then
    echo "No certificates found (${CERT_DIR} does not exist)"
    exit 0
  fi
  found=false
  for domain_dir in "${CERT_DIR}"/*/; do
    [ -d "$domain_dir" ] || continue
    found=true
    domain_name="$(basename "$domain_dir")"
    echo ""
    echo "Domain: ${domain_name}"
    for pem_file in "${domain_dir}"*.pem; do
      [ -f "$pem_file" ] || continue
      echo "  $(basename "$pem_file"):"
      if command -v openssl >/dev/null 2>&1; then
        expiry=$(openssl x509 -enddate -noout -in "$pem_file" 2>/dev/null || echo "  (not a certificate)")
        echo "    ${expiry}"
      else
        echo "    (install openssl to check expiry)"
      fi
    done
  done
  if [ "$found" = false ]; then
    echo "No certificate directories found in ${CERT_DIR}"
  fi
  exit 0
fi

# ── Validation ──
if [ -z "$DOMAIN" ]; then
  echo "Error: --domain is required"
  echo "Run with --help for usage"
  exit 1
fi

DOMAIN_CERT_DIR="${CERT_DIR}/${DOMAIN}"
mkdir -p "$DOMAIN_CERT_DIR"

# ── Self-signed certificate ──
if [ "$SELF_SIGNED" = true ]; then
  echo "=== Generating self-signed certificate for ${DOMAIN} ==="

  if ! command -v openssl >/dev/null 2>&1; then
    echo "Error: openssl is required for self-signed certificates"
    exit 1
  fi

  CA_KEY="${DOMAIN_CERT_DIR}/ca-key.pem"
  CA_CERT="${DOMAIN_CERT_DIR}/ca.pem"
  SERVER_KEY="${DOMAIN_CERT_DIR}/key.pem"
  SERVER_CERT="${DOMAIN_CERT_DIR}/cert.pem"
  SERVER_CSR="${DOMAIN_CERT_DIR}/server.csr"

  # Generate CA key and cert
  openssl genrsa -out "$CA_KEY" 4096 2>/dev/null
  openssl req -new -x509 -key "$CA_KEY" -sha256 \
    -subj "/CN=PSFN Local CA" \
    -days 3650 \
    -out "$CA_CERT" 2>/dev/null

  # Generate server key and CSR
  openssl genrsa -out "$SERVER_KEY" 2048 2>/dev/null
  openssl req -new -key "$SERVER_KEY" \
    -subj "/CN=${DOMAIN}" \
    -out "$SERVER_CSR" 2>/dev/null

  # Sign server cert with CA, including SAN
  openssl x509 -req -in "$SERVER_CSR" \
    -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
    -days 825 -sha256 \
    -extfile <(printf "subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1" "$DOMAIN") \
    -out "$SERVER_CERT" 2>/dev/null

  rm -f "$SERVER_CSR" "${DOMAIN_CERT_DIR}/ca.srl"

  echo ""
  echo "=== Self-signed certificate created ==="
  echo "  CA cert:     ${CA_CERT}"
  echo "  Server cert: ${SERVER_CERT}"
  echo "  Server key:  ${SERVER_KEY}"
  echo ""
  echo "Add to your .env:"
  echo "  GATEWAY_TLS_CA_PATH=${CA_CERT}"
  echo ""
  echo "For LiteLLM proxy (docker-compose.yml), mount the server cert/key:"
  echo "  volumes:"
  echo "    - ${SERVER_CERT}:/certs/cert.pem:ro"
  echo "    - ${SERVER_KEY}:/certs/key.pem:ro"
  echo ""
  echo "Note: Self-signed certs do NOT auto-renew. Regenerate before expiry (825 days)."
  exit 0
fi

# ── ACME certificate via acme.sh ──
if [ -z "$DNS_PROVIDER" ]; then
  echo "Error: --provider is required for ACME certificates"
  echo "Run with --help for usage"
  exit 1
fi

# Check for acme.sh
ACME_SH=""
if command -v acme.sh >/dev/null 2>&1; then
  ACME_SH="acme.sh"
elif [ -f "${HOME}/.acme.sh/acme.sh" ]; then
  ACME_SH="${HOME}/.acme.sh/acme.sh"
else
  echo "acme.sh not found. Installing..."
  curl -sSL https://get.acme.sh | sh -s email="${CERT_EMAIL:-admin@${DOMAIN}}"
  ACME_SH="${HOME}/.acme.sh/acme.sh"
fi

# Map provider to acme.sh DNS plugin
case "$DNS_PROVIDER" in
  cloudflare|cf)
    DNS_PLUGIN="dns_cf"
    if [ -z "${CF_Token:-}" ] && [ -z "${CF_Key:-}" ]; then
      echo "Error: Cloudflare requires CF_Token (API token) or CF_Key+CF_Email (global key)"
      echo "  export CF_Token=your-api-token"
      exit 1
    fi
    ;;
  route53|aws)
    DNS_PLUGIN="dns_aws"
    if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
      echo "Error: Route53 requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY"
      exit 1
    fi
    ;;
  digitalocean|do)
    DNS_PLUGIN="dns_dgon"
    if [ -z "${DO_API_KEY:-}" ]; then
      echo "Error: DigitalOcean requires DO_API_KEY"
      exit 1
    fi
    ;;
  duckdns)
    DNS_PLUGIN="dns_duckdns"
    if [ -z "${DuckDNS_Token:-}" ]; then
      echo "Error: DuckDNS requires DuckDNS_Token"
      exit 1
    fi
    ;;
  *)
    echo "Error: Unsupported DNS provider '${DNS_PROVIDER}'"
    echo "Supported: cloudflare, route53, digitalocean, duckdns"
    exit 1
    ;;
esac

echo "=== Issuing ACME certificate for ${DOMAIN} via ${DNS_PROVIDER} ==="

# Determine ACME server flag
ACME_SERVER_FLAG=""
case "${ACME_SERVER}" in
  zerossl)   ACME_SERVER_FLAG="--server zerossl" ;;
  buypass)   ACME_SERVER_FLAG="--server buypass" ;;
  letsencrypt|"") ACME_SERVER_FLAG="--server letsencrypt" ;;
  *)         ACME_SERVER_FLAG="--server ${ACME_SERVER}" ;;
esac

# Issue certificate
# shellcheck disable=SC2086
"$ACME_SH" --issue \
  --dns "$DNS_PLUGIN" \
  -d "$DOMAIN" \
  ${ACME_SERVER_FLAG} \
  ${CERT_EMAIL:+--accountemail "$CERT_EMAIL"} \
  --force

# Install certificate to our cert directory
"$ACME_SH" --install-cert -d "$DOMAIN" \
  --cert-file "${DOMAIN_CERT_DIR}/cert.pem" \
  --key-file "${DOMAIN_CERT_DIR}/key.pem" \
  --fullchain-file "${DOMAIN_CERT_DIR}/fullchain.pem" \
  --ca-file "${DOMAIN_CERT_DIR}/ca.pem"

echo ""
echo "=== Certificate issued successfully ==="
echo "  Full chain:  ${DOMAIN_CERT_DIR}/fullchain.pem"
echo "  Certificate: ${DOMAIN_CERT_DIR}/cert.pem"
echo "  Private key: ${DOMAIN_CERT_DIR}/key.pem"
echo "  CA cert:     ${DOMAIN_CERT_DIR}/ca.pem"
echo ""
echo "Add to your .env:"
echo "  GATEWAY_TLS_CA_PATH=${DOMAIN_CERT_DIR}/ca.pem"
echo ""
echo "For LiteLLM proxy (docker-compose.yml), mount the server cert/key:"
echo "  volumes:"
echo "    - ${DOMAIN_CERT_DIR}/fullchain.pem:/certs/cert.pem:ro"
echo "    - ${DOMAIN_CERT_DIR}/key.pem:/certs/key.pem:ro"
echo ""

# ── Setup auto-renewal cron ──
echo "=== Setting up auto-renewal ==="
RENEWAL_CMD="${ACME_SH} --cron --home ${HOME}/.acme.sh"

# acme.sh typically installs its own cron entry during setup.
# Verify it exists; if not, add one.
if crontab -l 2>/dev/null | grep -q "acme.sh.*--cron"; then
  echo "Auto-renewal cron already configured by acme.sh"
else
  echo "Adding renewal cron entry..."
  (crontab -l 2>/dev/null; echo "0 3 * * * ${RENEWAL_CMD} > /dev/null 2>&1") | crontab -
  echo "Renewal cron installed: daily at 03:00"
fi

echo ""
echo "=== Done ==="
echo "Certificate will auto-renew via acme.sh cron job."
echo "See docs/TLS_SETUP.md for full configuration guide."
