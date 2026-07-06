#!/usr/bin/env bash
# shellcheck disable=SC2016
set -euo pipefail
exec 3>&2

NAMESPACE="${NAMESPACE:-psfn}"
HOST_ALIAS="${PSFN_KUBE_HOST:-psfn-pi}"
REMOTE_KUBECTL_COMMAND="${REMOTE_KUBECTL_COMMAND:-sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl}"
SECRET_NAME="${PSFN_APP_SECRET:-psfn-app}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-300s}"
SINCE_WINDOW="${SINCE_WINDOW:-15m}"
EXPECT_TAG=""
SOFT=false
SMOKE=false
VERBOSE=false
KUBE_MODE_REQUESTED="auto"
KUBE_MODE=""
GARDEN_PORT="${GARDEN_PORT:-10054}"
GATEWAY_PORT="${GATEWAY_PORT:-10053}"
COMPANION_MODEL_PATTERN="${COMPANION_MODEL_PATTERN:-companion|carlini}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-180}"
API_KEY_VALUE=""

APP_DEPLOYS=(psfn-agent psfn-gateway psfn-garden)
CHECK_COUNT=0
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
FAILED_CHECKS=()

usage() {
  cat <<'EOF'
Usage: scripts/ops/validate-kube-rollout.sh [options]

Post-rollout validation gate for the live PSFN k3s deployment.

Options:
  -n, --namespace NAME       Kubernetes namespace (default: psfn)
      --host ALIAS           SSH host alias for remote node commands (default: psfn-pi)
      --remote               Force kubectl and node-local checks through SSH
      --local                Force local kubectl and node-local checks
      --expect-tag TAG       Require app pod image tags to match TAG
      --timeout DURATION     Rollout timeout (default: 300s)
      --since DURATION       Agent log scan window (default: 15m)
      --secret NAME          App secret containing API_KEY (default: psfn-app)
      --garden-port PORT     Garden localhost port on the node (default: 10054)
      --gateway-port PORT    Gateway localhost port on the node (default: 10053)
      --companion-pattern RE Regex for the expected /v1/models companion route
      --smoke                Run a two-turn gateway chat smoke
      --smoke-timeout SEC    Per-smoke request timeout (default: 180)
      --soft                 Continue after failures and summarize at the end
  -v, --verbose              Print sanitized local/remote commands
  -h, --help                 Show this help

Auto mode uses local kubectl when available. Otherwise it runs kube commands as:
  ssh <host> sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl ...
EOF
}

die() {
  printf 'FAIL setup: %s\n' "$*" >&2
  exit 2
}

validate_port() {
  local name=$1
  local value=$2
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 || value > 65535 )); then
    die "$name must be a TCP port, got: $value"
  fi
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      -n|--namespace)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        NAMESPACE=$2
        shift 2
        ;;
      --host|--remote-host)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        HOST_ALIAS=$2
        shift 2
        ;;
      --remote)
        KUBE_MODE_REQUESTED="remote"
        shift
        ;;
      --local)
        KUBE_MODE_REQUESTED="local"
        shift
        ;;
      --expect-tag)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        EXPECT_TAG=$2
        shift 2
        ;;
      --timeout)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        ROLLOUT_TIMEOUT=$2
        shift 2
        ;;
      --since)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        SINCE_WINDOW=$2
        shift 2
        ;;
      --secret)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        SECRET_NAME=$2
        shift 2
        ;;
      --garden-port)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        GARDEN_PORT=$2
        shift 2
        ;;
      --gateway-port)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        GATEWAY_PORT=$2
        shift 2
        ;;
      --companion-pattern)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        COMPANION_MODEL_PATTERN=$2
        shift 2
        ;;
      --smoke)
        SMOKE=true
        shift
        ;;
      --smoke-timeout)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        SMOKE_TIMEOUT_SECONDS=$2
        shift 2
        ;;
      --soft)
        SOFT=true
        shift
        ;;
      -v|--verbose)
        VERBOSE=true
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done

  validate_port "garden port" "$GARDEN_PORT"
  validate_port "gateway port" "$GATEWAY_PORT"
  if [[ ! "$SMOKE_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || (( SMOKE_TIMEOUT_SECONDS < 1 )); then
    die "smoke timeout must be a positive integer, got: $SMOKE_TIMEOUT_SECONDS"
  fi
}

quote_args() {
  local result=""
  local arg
  local quoted
  for arg in "$@"; do
    printf -v quoted '%q' "$arg"
    if [[ -n "$result" ]]; then
      result+=" "
    fi
    result+="$quoted"
  done
  printf '%s' "$result"
}

shell_quote() {
  printf '%q' "$1"
}

verbose_log() {
  if [[ "$VERBOSE" == true ]]; then
    printf 'VERBOSE %s\n' "$*" >&3
  fi
}

select_kube_mode() {
  case "$KUBE_MODE_REQUESTED" in
    auto)
      if command -v kubectl >/dev/null 2>&1; then
        KUBE_MODE="local"
      else
        KUBE_MODE="remote"
      fi
      ;;
    local|remote)
      KUBE_MODE="$KUBE_MODE_REQUESTED"
      ;;
    *)
      die "unsupported kube mode: $KUBE_MODE_REQUESTED"
      ;;
  esac

  if [[ "$KUBE_MODE" == "local" ]] && ! command -v kubectl >/dev/null 2>&1; then
    die "local kubectl was requested but kubectl is not on PATH"
  fi
  if [[ "$KUBE_MODE" == "remote" ]] && ! command -v ssh >/dev/null 2>&1; then
    die "remote kubectl was selected but ssh is not on PATH"
  fi
  if ! command -v node >/dev/null 2>&1; then
    die "node is required for JSON validation"
  fi
}

run_kubectl() {
  local args
  args="$(quote_args "$@")"
  if [[ "$KUBE_MODE" == "remote" ]]; then
    local command
    command="${REMOTE_KUBECTL_COMMAND} ${args}"
    verbose_log "ssh ${HOST_ALIAS} ${command}"
    ssh "$HOST_ALIAS" "$command"
    return
  fi

  verbose_log "kubectl ${args}"
  kubectl "$@"
}

run_host_shell() {
  local command=$1
  if [[ "$KUBE_MODE" == "remote" ]]; then
    verbose_log "ssh ${HOST_ALIAS} ${command}"
    ssh "$HOST_ALIAS" "$command"
    return
  fi

  verbose_log "$command"
  bash -lc "$command"
}

run_host_node_with_api_key() {
  local script=$1
  if [[ -z "$API_KEY_VALUE" ]]; then
    printf 'API key has not been loaded\n'
    return 1
  fi

  if [[ "$KUBE_MODE" == "remote" ]]; then
    verbose_log "ssh ${HOST_ALIAS} 'IFS= read -r API_KEY; export API_KEY; node --input-type=module' <redacted-api-key+script>"
    {
      printf '%s\n' "$API_KEY_VALUE"
      printf '%s\n' "$script"
    } | ssh "$HOST_ALIAS" 'IFS= read -r API_KEY; export API_KEY; node --input-type=module'
    return
  fi

  verbose_log "node --input-type=module <redacted-api-key+script>"
  {
    printf '%s\n' "$API_KEY_VALUE"
    printf '%s\n' "$script"
  } | bash -c 'IFS= read -r API_KEY; export API_KEY; node --input-type=module'
}

trim_text() {
  tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

warn_line() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf 'WARN %s\n' "$*"
}

print_summary() {
  printf '\nSummary: %d checks, %d passed, %d failed, %d warnings\n' "$CHECK_COUNT" "$PASS_COUNT" "$FAIL_COUNT" "$WARN_COUNT"
  if ((${#FAILED_CHECKS[@]} > 0)); then
    printf 'Failed checks:\n'
    local check
    for check in "${FAILED_CHECKS[@]}"; do
      printf '  - %s\n' "$check"
    done
  fi
}

run_check() {
  local name=$1
  shift
  local tmp
  local status
  tmp="$(mktemp "${TMPDIR:-/tmp}/validate-kube-rollout.XXXXXX")" || die "mktemp failed"

  CHECK_COUNT=$((CHECK_COUNT + 1))
  printf '==> %s\n' "$name"

  if "$@" >"$tmp" 2>&1; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf 'PASS %s\n' "$name"
    if [[ -s "$tmp" ]]; then
      sed 's/^/  /' "$tmp"
    fi
    rm -f "$tmp"
    return 0
  fi

  status=$?
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_CHECKS+=("$name")
  printf 'FAIL %s\n' "$name"
  if [[ -s "$tmp" ]]; then
    sed 's/^/  /' "$tmp"
  fi
  rm -f "$tmp"

  if [[ "$SOFT" != true ]]; then
    print_summary
    exit "$status"
  fi
  return 0
}

ensure_api_key() {
  if [[ -n "$API_KEY_VALUE" ]]; then
    return 0
  fi

  local encoded
  if ! encoded="$(run_kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" -o 'jsonpath={.data.API_KEY}' 2>&1)"; then
    printf 'failed to read API_KEY from secret/%s: %s\n' "$SECRET_NAME" "$encoded"
    return 1
  fi
  encoded="$(printf '%s' "$encoded" | trim_text)"
  if [[ -z "$encoded" ]]; then
    printf 'secret/%s does not contain data.API_KEY\n' "$SECRET_NAME"
    return 1
  fi

  local decoded
  if ! decoded="$(printf '%s' "$encoded" | node -e 'const fs = require("node:fs"); const raw = fs.readFileSync(0, "utf8").trim(); process.stdout.write(Buffer.from(raw, "base64").toString("utf8").trim());' 2>&1)"; then
    printf 'failed to decode API_KEY from secret/%s: %s\n' "$SECRET_NAME" "$decoded"
    return 1
  fi
  if [[ -z "$decoded" ]]; then
    printf 'decoded API_KEY from secret/%s is empty\n' "$SECRET_NAME"
    return 1
  fi

  API_KEY_VALUE=$decoded
}

check_rollout_status() {
  local deploy
  local output
  for deploy in "${APP_DEPLOYS[@]}"; do
    if ! output="$(run_kubectl -n "$NAMESPACE" rollout status "deploy/${deploy}" "--timeout=${ROLLOUT_TIMEOUT}" 2>&1)"; then
      printf '%s\n' "$output"
      return 1
    fi
    printf '%s\n' "$output"
  done
}

check_app_pods_and_images() {
  local pods_json
  if ! pods_json="$(run_kubectl -n "$NAMESPACE" get pods -o json 2>&1)"; then
    printf 'failed to list pods: %s\n' "$pods_json"
    return 1
  fi

  local app_deploys_csv
  app_deploys_csv="$(IFS=,; printf '%s' "${APP_DEPLOYS[*]}")"
  printf '%s' "$pods_json" | APP_DEPLOYS="$app_deploys_csv" EXPECT_TAG="$EXPECT_TAG" node -e '
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const deploys = process.env.APP_DEPLOYS.split(",").filter(Boolean);
const expectTag = process.env.EXPECT_TAG || "";
const pods = Array.isArray(payload.items) ? payload.items : [];
const selected = pods.filter((pod) => deploys.some((deploy) => String(pod.metadata?.name ?? "").startsWith(`${deploy}-`)));
const failures = [];
const imageSummaries = [];

function imageTag(image) {
  const withoutDigest = String(image).split("@")[0];
  const slashIndex = withoutDigest.lastIndexOf("/");
  const colonIndex = withoutDigest.lastIndexOf(":");
  return colonIndex > slashIndex ? withoutDigest.slice(colonIndex + 1) : "";
}

for (const deploy of deploys) {
  const matching = selected.filter((pod) => String(pod.metadata?.name ?? "").startsWith(`${deploy}-`));
  if (matching.length === 0) {
    failures.push(`${deploy}: no pods found`);
  }
}

for (const pod of selected) {
  const name = String(pod.metadata?.name ?? "<unknown>");
  if (pod.metadata?.deletionTimestamp) {
    failures.push(`${name}: pod is terminating`);
  }
  const phase = String(pod.status?.phase ?? "");
  if (phase !== "Running") {
    failures.push(`${name}: phase=${phase || "<missing>"}`);
  }

  const containers = Array.isArray(pod.spec?.containers) ? pod.spec.containers : [];
  for (const container of containers) {
    const image = String(container.image ?? "");
    const tag = imageTag(image);
    imageSummaries.push(`${name}/${container.name ?? "container"}=${image}`);
    if (expectTag && tag !== expectTag) {
      failures.push(`${name}/${container.name ?? "container"}: image tag ${tag || "<none>"} != ${expectTag}`);
    }
  }
}

if (selected.length === 0) {
  failures.push("no app pods matched psfn-agent, psfn-gateway, or psfn-garden");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`${selected.length} app pods are Running`);
if (expectTag) {
  console.log(`all app pod image tags match ${expectTag}`);
}
console.log(`images: ${imageSummaries.join(", ")}`);
'
}

check_garden_health() {
  local url
  local command
  local response
  local http_status
  local body
  url="http://127.0.0.1:${GARDEN_PORT}/health"
  command="curl -sS --max-time 10 -w '\\n%{http_code}' $(shell_quote "$url")"
  if ! response="$(run_host_shell "$command" 2>&1)"; then
    printf 'garden health curl failed: %s\n' "$response"
    return 1
  fi
  http_status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [[ "$http_status" != "200" ]]; then
    printf 'garden health returned HTTP %s\n' "$http_status"
    printf '%s\n' "$body"
    return 1
  fi

  printf '%s' "$body" | node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
let payload;
try {
  payload = JSON.parse(raw);
} catch (error) {
  console.error(`garden health returned invalid JSON: ${error.message}`);
  process.exit(1);
}
const adminTransport = payload.dependencies?.adminTransport ?? payload.adminTransport;
const adminStatus = adminTransport?.status;
if (payload.status !== "ok" || adminStatus !== "ok") {
  console.error(`garden health degraded: status=${payload.status ?? "<missing>"} adminTransport=${adminStatus ?? "<missing>"}`);
  process.exit(1);
}
console.log("garden health status=ok adminTransport=ok");
'
}

fetch_gateway_models_response() {
  local script
  script=$(cat <<EOF
const port = ${GATEWAY_PORT};
const res = await fetch(\`http://127.0.0.1:\${port}/v1/models\`, {
  headers: { authorization: \`Bearer \${process.env.API_KEY ?? ""}\` },
});
const body = await res.text();
process.stdout.write(JSON.stringify({ status: res.status, ok: res.ok, body }));
EOF
)
  run_host_node_with_api_key "$script"
}

check_gateway_models() {
  ensure_api_key || return 1

  local response
  if ! response="$(fetch_gateway_models_response 2>&1)"; then
    printf 'gateway /v1/models request failed: %s\n' "$response"
    return 1
  fi

  printf '%s' "$response" | COMPANION_MODEL_PATTERN="$COMPANION_MODEL_PATTERN" node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
let wrapper;
try {
  wrapper = JSON.parse(raw);
} catch (error) {
  console.error(`gateway models wrapper was invalid JSON: ${error.message}`);
  process.exit(1);
}
if (wrapper.status !== 200) {
  console.error(`gateway /v1/models returned HTTP ${wrapper.status}`);
  process.exit(1);
}
let payload;
try {
  payload = JSON.parse(wrapper.body);
} catch (error) {
  console.error(`gateway /v1/models body was invalid JSON: ${error.message}`);
  process.exit(1);
}
const ids = Array.isArray(payload.data)
  ? payload.data.map((entry) => entry?.id).filter((id) => typeof id === "string" && id.length > 0)
  : [];
let pattern;
try {
  pattern = new RegExp(process.env.COMPANION_MODEL_PATTERN || "companion|carlini", "i");
} catch (error) {
  console.error(`invalid companion route regex: ${error.message}`);
  process.exit(1);
}
if (!ids.some((id) => pattern.test(id))) {
  console.error(`companion route not found in /v1/models; ids=${ids.join(", ") || "<none>"}`);
  process.exit(1);
}
console.log(`gateway /v1/models HTTP 200; ids=${ids.join(", ")}`);
'
}

run_postgres_sql() {
  local sql=$1
  run_kubectl -n "$NAMESPACE" exec sts/psfn-postgres -- psql -U psfn -d psfn -tAc "$sql"
}

check_postgres_and_redis() {
  local vector_output
  if ! vector_output="$(run_postgres_sql "select extname from pg_extension where extname='vector';" 2>&1)"; then
    printf 'pgvector query failed: %s\n' "$vector_output"
    return 1
  fi
  vector_output="$(printf '%s' "$vector_output" | trim_text)"
  if [[ "$vector_output" != "vector" ]]; then
    printf 'pgvector extension missing; query returned: %s\n' "${vector_output:-<empty>}"
    return 1
  fi

  local redis_output
  if ! redis_output="$(run_kubectl -n "$NAMESPACE" exec sts/psfn-redis -- sh -lc 'redis-cli -a "$REDIS_PASSWORD" ping' 2>&1)"; then
    printf 'redis ping failed: %s\n' "$redis_output"
    return 1
  fi
  if ! printf '%s\n' "$redis_output" | grep -qx 'PONG'; then
    printf 'redis ping did not return PONG: %s\n' "$redis_output"
    return 1
  fi

  printf 'postgres pgvector=present; redis=PONG\n'
}

agent_pod_names_from_json() {
  node -e '
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const pods = Array.isArray(payload.items) ? payload.items : [];
for (const pod of pods) {
  const name = String(pod.metadata?.name ?? "");
  if (name.startsWith("psfn-agent-")) console.log(name);
}
'
}

check_agent_pod_crashloops() {
  node -e '
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const pods = Array.isArray(payload.items) ? payload.items : [];
const failures = [];
for (const pod of pods) {
  const name = String(pod.metadata?.name ?? "");
  if (!name.startsWith("psfn-agent-")) continue;
  const statuses = [
    ...(Array.isArray(pod.status?.containerStatuses) ? pod.status.containerStatuses : []),
    ...(Array.isArray(pod.status?.initContainerStatuses) ? pod.status.initContainerStatuses : []),
  ];
  for (const status of statuses) {
    const reason = status.state?.waiting?.reason ?? status.lastState?.terminated?.reason ?? "";
    if (reason === "CrashLoopBackOff") {
      failures.push(`${name}/${status.name}: CrashLoopBackOff`);
    }
  }
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("no psfn-agent containers report CrashLoopBackOff");
'
}

check_agent_log_patterns() {
  SINCE_WINDOW="$SINCE_WINDOW" node -e '
const fs = require("node:fs");
const text = fs.readFileSync(0, "utf8");
const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
const fatal = [];
const ownerFileErrors = lines.filter((line) => {
  const lower = line.toLowerCase();
  return (
    (lower.includes("owner-file") || lower.includes("owner file") || lower.includes("owner files"))
    && /(error|failed|missing|invalid|required)/i.test(line)
  ) || (
    lower.includes("startup")
    && (lower.includes("owner-file") || lower.includes("owner file") || lower.includes("owner files"))
  );
});
const enoentConfigErrors = lines.filter((line) => /ENOENT/i.test(line) && /(config|settings|models|scheduler|channels|skills|trust-policy|capability-tier|owner-file|owner file)/i.test(line));
const validationFailures = lines.filter((line) => line.includes("Validation failed for tool"));
if (/CrashLoopBackOff/.test(text)) fatal.push("agent logs mention CrashLoopBackOff");
if (ownerFileErrors.length > 0) fatal.push(`startup owner-file errors=${ownerFileErrors.length}`);
if (enoentConfigErrors.length > 0) fatal.push(`ENOENT config errors=${enoentConfigErrors.length}`);
if (validationFailures.length > 1) fatal.push(`repeated Validation failed for tool=${validationFailures.length}`);
if (fatal.length > 0) {
  console.error(fatal.join("\n"));
  process.exit(1);
}
console.log(`agent logs scanned since ${process.env.SINCE_WINDOW}; lines=${lines.length}; Validation failed for tool=${validationFailures.length}`);
'
}

check_agent_logs() {
  local pods_json
  if ! pods_json="$(run_kubectl -n "$NAMESPACE" get pods -o json 2>&1)"; then
    printf 'failed to list pods for log scan: %s\n' "$pods_json"
    return 1
  fi

  printf '%s' "$pods_json" | check_agent_pod_crashloops || return 1

  local pod_names
  if ! pod_names="$(printf '%s' "$pods_json" | agent_pod_names_from_json 2>&1)"; then
    printf 'failed to parse agent pod names: %s\n' "$pod_names"
    return 1
  fi
  if [[ -z "$pod_names" ]]; then
    printf 'no psfn-agent pods found for log scan\n'
    return 1
  fi

  local logs=""
  local pod
  local pod_logs
  while IFS= read -r pod; do
    [[ -n "$pod" ]] || continue
    if ! pod_logs="$(run_kubectl -n "$NAMESPACE" logs "pod/${pod}" "--since=${SINCE_WINDOW}" --all-containers=true --prefix=true 2>&1)"; then
      printf 'failed reading logs for %s: %s\n' "$pod" "$pod_logs"
      return 1
    fi
    logs+=$'\n'
    logs+="$pod_logs"
  done <<<"$pod_names"

  printf '%s' "$logs" | check_agent_log_patterns || return 1

  local warn_count
  warn_count="$(printf '%s\n' "$logs" | grep -Eic '(^|[^[:alpha:]])warn(ing)?([^[:alpha:]]|$)' || true)"
  if (( warn_count > 0 )); then
    warn_line "agent logs contain ${warn_count} WARN/WARNING lines since ${SINCE_WINDOW}"
  else
    printf 'agent logs contain 0 WARN/WARNING lines since %s\n' "$SINCE_WINDOW"
  fi
}

check_provider_routing() {
  local sql
  sql="select concat_ws('|', case when requested_provider = provider then 'OK' else 'FAIL' end, coalesce(requested_provider, ''), provider, coalesce(requested_model, ''), model, recorded_at_ms::text) from model_usage_events where call_kind='chat' order by recorded_at_ms desc, id desc limit 1;"

  local output
  if ! output="$(run_postgres_sql "$sql" 2>&1)"; then
    printf 'provider-routing query failed: %s\n' "$output"
    return 1
  fi
  output="$(printf '%s' "$output" | trim_text)"
  if [[ -z "$output" ]]; then
    printf 'provider-routing check found no chat rows in model_usage_events\n'
    return 1
  fi

  IFS='|' read -r status requested_provider actual_provider requested_model actual_model recorded_at_ms <<<"$output"
  if [[ "$status" != "OK" ]]; then
    printf 'last chat row provider mismatch: requested_provider=%s provider=%s requested_model=%s model=%s recorded_at_ms=%s\n' \
      "${requested_provider:-<empty>}" \
      "${actual_provider:-<empty>}" \
      "${requested_model:-<empty>}" \
      "${actual_model:-<empty>}" \
      "${recorded_at_ms:-<empty>}"
    return 1
  fi

  printf 'last chat row provider matched: requested_provider=%s provider=%s model=%s recorded_at_ms=%s\n' \
    "$requested_provider" "$actual_provider" "$actual_model" "$recorded_at_ms"
}

check_zero_bookkeeping_writes() {
  local sql
  sql="select count(*) from session_messages_projection where author_name in ('CompletionHandoff','BackgroundContinuation');"

  local output
  if ! output="$(run_postgres_sql "$sql" 2>&1)"; then
    printf 'bookkeeping projection query failed: %s\n' "$output"
    return 1
  fi
  output="$(printf '%s' "$output" | trim_text)"
  if [[ "$output" != "0" ]]; then
    printf 'bookkeeping projection rows present: %s\n' "${output:-<empty>}"
    return 1
  fi

  printf 'bookkeeping projection rows=0\n'
}

check_gateway_smoke() {
  ensure_api_key || return 1

  local script
  script=$(cat <<EOF
const port = ${GATEWAY_PORT};
const timeoutMs = ${SMOKE_TIMEOUT_SECONDS} * 1000;
const runId = \`kube-rollout-validation-\${Date.now().toString(36)}\`;
const marker = \`rollout-\${Math.random().toString(36).slice(2, 10)}\`;
const baseUrl = \`http://127.0.0.1:\${port}\`;
const authHeaders = { authorization: \`Bearer \${process.env.API_KEY ?? ""}\` };

async function fetchWithTimeout(path, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(\`\${baseUrl}\${path}\`, { ...options, signal: controller.signal });
    const body = await res.text();
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(\`\${label} returned invalid JSON: \${error.message}\`);
  }
}

const modelsRes = await fetchWithTimeout("/v1/models", { headers: authHeaders });
if (modelsRes.status !== 200) {
  throw new Error(\`/v1/models returned HTTP \${modelsRes.status}\`);
}
const modelsPayload = parseJson("/v1/models", modelsRes.body);
const model = Array.isArray(modelsPayload.data)
  ? modelsPayload.data.map((entry) => entry?.id).find((id) => typeof id === "string" && id.length > 0)
  : undefined;
if (!model) {
  throw new Error("/v1/models did not return a usable model id");
}

async function chat(messages) {
  const res = await fetchWithTimeout("/v1/chat/completions", {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": "application/json",
      "x-session-id": runId,
    },
    body: JSON.stringify({
      model,
      user: runId,
      messages,
      temperature: 0,
      max_tokens: 160,
    }),
  });
  const payload = res.body ? parseJson("/v1/chat/completions", res.body) : null;
  return { status: res.status, ok: res.ok, payload };
}

const first = await chat([
  { role: "user", content: \`Rollout validation turn one. Reply briefly and include this marker: \${marker}\` },
]);
if (first.status !== 200) {
  throw new Error(\`first smoke turn returned HTTP \${first.status}\`);
}
const second = await chat([
  { role: "user", content: \`This is rollout validation turn two. Refer to the prior validation marker \${marker} in one short reply.\` },
]);
if (second.status !== 200) {
  throw new Error(\`second smoke turn returned HTTP \${second.status}\`);
}
const content = String(second.payload?.choices?.[0]?.message?.content ?? "").trim();
if (!content) {
  throw new Error("second smoke reply was empty");
}
process.stdout.write(JSON.stringify({
  model,
  validationUser: runId,
  firstStatus: first.status,
  secondStatus: second.status,
  secondReplyChars: content.length,
}));
EOF
)

  local response
  if ! response="$(run_host_node_with_api_key "$script" 2>&1)"; then
    printf 'gateway smoke failed: %s\n' "$response"
    return 1
  fi

  printf '%s' "$response" | node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
let payload;
try {
  payload = JSON.parse(raw);
} catch (error) {
  console.error(`smoke result was invalid JSON: ${error.message}`);
  process.exit(1);
}
console.log(`gateway smoke passed: model=${payload.model} user=${payload.validationUser} statuses=${payload.firstStatus}/${payload.secondStatus} second_reply_chars=${payload.secondReplyChars}`);
'
}

main() {
  parse_args "$@"
  select_kube_mode

  printf 'PSFN kube rollout validation\n'
  printf 'namespace=%s mode=%s host=%s rollout_timeout=%s log_since=%s\n' \
    "$NAMESPACE" "$KUBE_MODE" "$HOST_ALIAS" "$ROLLOUT_TIMEOUT" "$SINCE_WINDOW"
  if [[ -n "$EXPECT_TAG" ]]; then
    printf 'expect_tag=%s\n' "$EXPECT_TAG"
  fi

  run_check "rollout status" check_rollout_status
  run_check "app pods and images" check_app_pods_and_images
  run_check "garden health" check_garden_health
  run_check "gateway models" check_gateway_models
  run_check "postgres pgvector and redis" check_postgres_and_redis
  run_check "agent log scan" check_agent_logs
  run_check "provider routing" check_provider_routing
  run_check "zero bookkeeping writes" check_zero_bookkeeping_writes
  if [[ "$SMOKE" == true ]]; then
    run_check "gateway chat smoke" check_gateway_smoke
  fi

  print_summary
  if (( FAIL_COUNT > 0 )); then
    exit 1
  fi
}

main "$@"
