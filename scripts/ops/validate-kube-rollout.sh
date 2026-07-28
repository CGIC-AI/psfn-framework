#!/usr/bin/env bash
# shellcheck disable=SC2016
set -euo pipefail
exec 3>&2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ops/load-private-ops-config.sh
source "$SCRIPT_DIR/load-private-ops-config.sh"
load_private_ops_config "$SCRIPT_DIR"

NAMESPACE="${PSFN_NAMESPACE:-${NAMESPACE:-psfn}}"
HOST_ALIAS="${PSFN_HOST_ALIAS:-}"
REMOTE_KUBECTL_COMMAND="${REMOTE_KUBECTL_COMMAND:-sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl}"
SECRET_NAME="${PSFN_APP_SECRET:-psfn-app}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-300s}"
SINCE_WINDOW="${SINCE_WINDOW:-15m}"
EXPECT_TAG=""
SOFT=false
SMOKE=false
VERBOSE=false
CHECK_PROVIDER_ROUTING=true
LIST_APP_DEPLOYMENTS=false
KUBE_MODE_REQUESTED="auto"
KUBE_MODE=""
GARDEN_PORT="${GARDEN_PORT:-10054}"
GATEWAY_PORT="${GATEWAY_PORT:-10053}"
# Empty = resolve from the live gateway deployment's COMPANION_ID env.
COMPANION_MODEL_PATTERN="${COMPANION_MODEL_PATTERN:-}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-180}"
TESTING_HARNESS_API_KEY_VALUE=""
TESTING_HARNESS_SECRET_KEY=""
GARDEN_HEALTH_CHECK_MODE=""
GARDEN_HEALTH_CHECK_LABEL="garden health"

APP_DEPLOYS=(psfn-gateway psfn-garden)

# Exit status a check function returns when a declared prerequisite failed, so
# the check could not run at all. It is deliberately distinct from 1 (the check
# ran and the assertion failed) because the two mean opposite things about
# coverage: a failed check validated something, a skipped check validated
# nothing.
CHECK_SKIPPED_STATUS=3

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0
SKIP_COUNT=0
REQUESTED_SKIP_COUNT=0
NOT_RUN_COUNT=0
FAILED_CHECKS=()
SKIPPED_CHECKS=()
REQUESTED_SKIP_CHECKS=()
NOT_RUN_CHECKS=()
PLANNED_CHECK_SCOPES=()
PLANNED_CHECK_NAMES=()
PLANNED_CHECK_FUNCS=()
ABORTED_BY_CHECK=""

usage() {
  cat <<'EOF'
Usage: scripts/ops/validate-kube-rollout.sh [options]

Post-rollout validation gate for the live PSFN k3s deployment.

Options:
  -n, --namespace NAME       Kubernetes namespace (default: psfn)
      --host ALIAS           SSH destination for remote node commands (required remotely)
      --remote               Force kubectl and node-local checks through SSH
      --local                Force local kubectl and node-local checks
      --expect-tag TAG       Require app pod image tags to match TAG
      --timeout DURATION     Rollout timeout (default: 300s)
      --since DURATION       Agent log scan window (default: 15m)
      --secret NAME          App secret containing TESTING_HARNESS_API_KEY (default: psfn-app)
      --garden-port PORT     Garden localhost port on the node (default: 10054)
      --gateway-port PORT    Gateway localhost port on the node (default: 10053)
      --companion-pattern RE Regex for the expected /v1/models companion route
      --skip-provider-routing
                            Skip latest chat model_usage_events provider check
      --list-app-deployments
                            Print discovered fleet app Deployments and exit
      --smoke                Run a two-turn gateway chat smoke
      --smoke-timeout SEC    Per-smoke request timeout (default: 180)
      --soft                 Continue after failures and summarize at the end
  -v, --verbose              Print sanitized local/remote commands
  -h, --help                 Show this help

Auto mode uses local kubectl when available. Otherwise it runs kube commands as:
  ssh <host> sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl ...

Coverage accounting: the gate plans its full check set up front and the summary
always reports that plan. A check is PASS, FAIL, SKIP (a prerequisite failed, so
nothing was validated), or NOT RUN (an earlier gate failure aborted the run).
Anything other than PASS/FAIL leaves coverage incomplete and the gate exits
non-zero, so a partial run can never read as a validated deploy.

Exit status: 0 all planned checks passed (operator-requested skips allowed);
1 at least one check failed, was skipped, or did not run; 2 setup error.
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
      --skip-provider-routing)
        CHECK_PROVIDER_ROUTING=false
        shift
        ;;
      --list-app-deployments)
        LIST_APP_DEPLOYMENTS=true
        shift
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
  if [[ "$KUBE_MODE" == "remote" ]]; then
    require_private_ops_value HOST_ALIAS "--host" PSFN_HOST_ALIAS || exit 2
  fi
  if ! command -v node >/dev/null 2>&1; then
    die "node is required for JSON validation"
  fi
}

discover_app_deployments() {
  local deployments_json
  if ! deployments_json="$(run_kubectl -n "$NAMESPACE" get deployments \
    -l 'psfn.io/fleet-target=registered' -o json 2>&1)"; then
    printf 'failed to discover registered fleet agent Deployments: %s\n' "$deployments_json" >&2
    return 1
  fi
  local agent_deployments
  if ! agent_deployments="$(printf '%s' "$deployments_json" | node -e '
    const fs = require("node:fs");
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    const names = (Array.isArray(payload.items) ? payload.items : [])
      .map(item => item.metadata?.name)
      .filter(name => typeof name === "string" && name.length > 0)
      .sort();
    process.stdout.write(names.join("\n"));
  ' 2>&1)"; then
    printf 'failed to parse registered fleet agent Deployments: %s\n' "$agent_deployments" >&2
    return 1
  fi
  if [[ -z "$agent_deployments" ]]; then
    printf 'no registered fleet agent Deployments found\n' >&2
    return 1
  fi
  APP_DEPLOYS=(psfn-gateway psfn-garden)
  while IFS= read -r deploy; do
    [[ -n "$deploy" ]] || continue
    APP_DEPLOYS+=("$deploy")
  done <<<"$agent_deployments"
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

# Deployments expose their ports either on the node (hostPort topology) or
# only in-cluster behind an Ingress.
# Host-level curls/node fetches are authoritative when a hostPort is bound —
# they verify node exposure — otherwise the same check runs inside the pod.
declare -A HOST_PORT_CACHE=()
deploy_binds_host_port() {
  local deploy=$1
  if [[ -z "${HOST_PORT_CACHE[$deploy]+x}" ]]; then
    HOST_PORT_CACHE[$deploy]="$(run_kubectl -n "$NAMESPACE" get deploy "$deploy" \
      -o 'jsonpath={.spec.template.spec.containers[*].ports[*].hostPort}' 2>/dev/null | tr -d '[:space:]')"
  fi
  [[ -n "${HOST_PORT_CACHE[$deploy]}" ]]
}

resolve_garden_health_check_mode() {
  local port_name
  if ! port_name="$(run_kubectl -n "$NAMESPACE" get deploy psfn-garden \
    -o 'jsonpath={.spec.template.spec.containers[?(@.name=="garden")].ports[0].name}' 2>&1)"; then
    printf 'failed to inspect the Garden listener transport: %s\n' "$port_name" >&2
    return 1
  fi
  port_name="$(printf '%s' "$port_name" | trim_text)"
  case "$port_name" in
    https-garden)
      # The fleet listener admits only the gateway SPIFFE principal. The
      # garden-admin client certificate is for Garden -> agent admin transport,
      # so an out-of-band /health curl cannot satisfy this listener contract.
      GARDEN_HEALTH_CHECK_MODE="pod-readiness"
      GARDEN_HEALTH_CHECK_LABEL="garden health (pod readiness)"
      ;;
    http-garden)
      GARDEN_HEALTH_CHECK_MODE="http"
      GARDEN_HEALTH_CHECK_LABEL="garden health"
      ;;
    *)
      printf 'unsupported Garden listener port name: %s\n' "${port_name:-<missing>}" >&2
      return 1
      ;;
  esac
}

run_pod_node() {
  local deploy=$1
  local script=$2
  local container="${deploy#psfn-}"
  verbose_log "kubectl exec -i deploy/${deploy} -c ${container} -- node --input-type=module <script>"
  printf '%s\n' "$script" | run_kubectl -n "$NAMESPACE" exec -i "deploy/${deploy}" -c "$container" -- node --input-type=module
}

run_host_node_with_testing_harness_key() {
  local script=$1
  if [[ -z "$TESTING_HARNESS_API_KEY_VALUE" ]]; then
    printf 'Testing-harness API key has not been loaded\n'
    return 1
  fi

  if ! deploy_binds_host_port psfn-gateway; then
    verbose_log "kubectl exec -i deploy/psfn-gateway -- node --input-type=module <redacted-api-key+script> (no gateway hostPort)"
    {
      printf '%s\n' "$TESTING_HARNESS_API_KEY_VALUE"
      printf '%s\n' "$script"
    } | run_kubectl -n "$NAMESPACE" exec -i deploy/psfn-gateway -c gateway -- sh -c 'IFS= read -r TESTING_HARNESS_API_KEY; export TESTING_HARNESS_API_KEY; node --input-type=module'
    return
  fi

  if [[ "$KUBE_MODE" == "remote" ]]; then
    verbose_log "ssh ${HOST_ALIAS} 'IFS= read -r TESTING_HARNESS_API_KEY; export TESTING_HARNESS_API_KEY; node --input-type=module' <redacted-testing-harness-key+script>"
    {
      printf '%s\n' "$TESTING_HARNESS_API_KEY_VALUE"
      printf '%s\n' "$script"
    } | ssh "$HOST_ALIAS" 'IFS= read -r TESTING_HARNESS_API_KEY; export TESTING_HARNESS_API_KEY; node --input-type=module'
    return
  fi

  verbose_log "node --input-type=module <redacted-api-key+script>"
  {
    printf '%s\n' "$TESTING_HARNESS_API_KEY_VALUE"
    printf '%s\n' "$script"
  } | bash -c 'IFS= read -r TESTING_HARNESS_API_KEY; export TESTING_HARNESS_API_KEY; node --input-type=module'
}

trim_text() {
  tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

warn_line() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf 'WARN %s\n' "$*"
}

planned_check_total() {
  printf '%d' "${#PLANNED_CHECK_NAMES[@]}"
}

print_named_checks() {
  local heading=$1
  local -n entries=$2
  ((${#entries[@]} > 0)) || return 0
  printf '%s\n' "$heading"
  local check
  for check in "${entries[@]}"; do
    printf '  - %s\n' "$check"
  done
}

print_summary() {
  local planned executed unvalidated
  planned="$(planned_check_total)"
  executed=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
  unvalidated=$((FAIL_COUNT + SKIP_COUNT + REQUESTED_SKIP_COUNT + NOT_RUN_COUNT))

  printf '\nSummary: %d checks planned, %d ran; %d passed, %d failed, %d skipped, %d requested-skip, %d not run, %d warnings\n' \
    "$planned" "$executed" "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT" \
    "$REQUESTED_SKIP_COUNT" "$NOT_RUN_COUNT" "$WARN_COUNT"

  print_named_checks 'Failed checks:' FAILED_CHECKS
  print_named_checks 'SKIPPED — prerequisite failed, nothing was validated:' SKIPPED_CHECKS
  print_named_checks 'SKIPPED by operator request, nothing was validated:' REQUESTED_SKIP_CHECKS
  print_named_checks \
    "NOT RUN — gate aborted after \"${ABORTED_BY_CHECK}\" failed, nothing was validated:" \
    NOT_RUN_CHECKS

  if ((FAIL_COUNT + SKIP_COUNT + NOT_RUN_COUNT > 0)); then
    printf 'COVERAGE INCOMPLETE: %d of %d planned checks did not pass. This is NOT a validated deploy.\n' \
      "$unvalidated" "$planned"
  elif ((REQUESTED_SKIP_COUNT > 0)); then
    printf 'COVERAGE REDUCED BY REQUEST: %d of %d planned checks validated nothing because the operator skipped them.\n' \
      "$REQUESTED_SKIP_COUNT" "$planned"
  fi
}

# Scope decides what a failure costs:
#   gate   — the failure invalidates the run; abort the remaining checks unless
#            --soft, and name every check that therefore did not run.
#   scoped — the failure invalidates only the checks that declare it as a
#            prerequisite; those report SKIP and everything else still runs.
plan_check() {
  PLANNED_CHECK_SCOPES+=("$1")
  PLANNED_CHECK_NAMES+=("$2")
  PLANNED_CHECK_FUNCS+=("$3")
}

# A check the operator asked not to run. It stays in the plan so the summary
# still names it as unvalidated.
plan_requested_skip() {
  PLANNED_CHECK_SCOPES+=("requested-skip")
  PLANNED_CHECK_NAMES+=("$1")
  PLANNED_CHECK_FUNCS+=("$2")
}

first_line() {
  local text=$1
  printf '%s' "${text%%$'\n'*}"
}

# Returns 0 to continue the plan, 1 to abort it.
#
# Bash locals are dynamically scoped, so a check function that assigns an
# undeclared variable overwrites this frame's local of the same name. Every
# local here therefore carries a check_ prefix that no check body uses.
run_check() {
  local check_scope=$1
  local check_name=$2
  local check_function=$3
  local check_output_file
  local check_status
  local check_output

  if [[ "$check_scope" == "requested-skip" ]]; then
    REQUESTED_SKIP_COUNT=$((REQUESTED_SKIP_COUNT + 1))
    REQUESTED_SKIP_CHECKS+=("${check_name}: not run at operator request")
    printf '==> %s\n' "$check_name"
    printf 'SKIP %s (operator request; nothing was validated)\n' "$check_name"
    return 0
  fi

  check_output_file="$(mktemp "${TMPDIR:-/tmp}/validate-kube-rollout.XXXXXX")" || die "mktemp failed"
  printf '==> %s\n' "$check_name"

  check_status=0
  "$check_function" >"$check_output_file" 2>&1 || check_status=$?
  check_output="$(cat "$check_output_file")"
  rm -f "$check_output_file"

  if ((check_status == 0)); then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf 'PASS %s\n' "$check_name"
    if [[ -n "$check_output" ]]; then
      printf '%s\n' "$check_output" | sed 's/^/  /'
    fi
    return 0
  fi

  if ((check_status == CHECK_SKIPPED_STATUS)); then
    SKIP_COUNT=$((SKIP_COUNT + 1))
    SKIPPED_CHECKS+=("${check_name}: $(first_line "$check_output")")
    printf 'SKIP %s (nothing was validated)\n' "$check_name"
    if [[ -n "$check_output" ]]; then
      printf '%s\n' "$check_output" | sed 's/^/  /'
    fi
    return 0
  fi

  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_CHECKS+=("$check_name")
  printf 'FAIL %s\n' "$check_name"
  if [[ -n "$check_output" ]]; then
    printf '%s\n' "$check_output" | sed 's/^/  /'
  fi

  # A scoped failure is already accounted for by the SKIP lines its dependents
  # emit, so it never costs the rest of the plan.
  if [[ "$check_scope" == "scoped" || "$SOFT" == true ]]; then
    return 0
  fi
  return 1
}

run_check_plan() {
  local total index remaining
  total="$(planned_check_total)"
  for ((index = 0; index < total; index++)); do
    if run_check "${PLANNED_CHECK_SCOPES[index]}" "${PLANNED_CHECK_NAMES[index]}" \
      "${PLANNED_CHECK_FUNCS[index]}"; then
      continue
    fi

    ABORTED_BY_CHECK="${PLANNED_CHECK_NAMES[index]}"
    for ((remaining = index + 1; remaining < total; remaining++)); do
      NOT_RUN_COUNT=$((NOT_RUN_COUNT + 1))
      NOT_RUN_CHECKS+=("${PLANNED_CHECK_NAMES[remaining]}")
    done
    if ((NOT_RUN_COUNT > 0)); then
      printf '\nGate aborted after "%s" failed; %d later check(s) were NOT RUN. Re-run with --soft to attempt them.\n' \
        "$ABORTED_BY_CHECK" "$NOT_RUN_COUNT"
    fi
    return 0
  done
}

# Reading the harness key is its own check rather than a side effect of the
# first check that needs it, so a missing or malformed key is reported once, in
# its own right, and costs exactly the two checks that must present a bearer
# token instead of aborting the whole gate (psfn-framework-zu0g5).
TESTING_HARNESS_KEY_STATE="unresolved"
TESTING_HARNESS_KEY_FAILURE=""

resolve_testing_harness_secret_key() {
  local deployment_json
  if ! deployment_json="$(run_kubectl -n "$NAMESPACE" get deploy psfn-gateway -o json 2>&1)"; then
    TESTING_HARNESS_KEY_FAILURE="failed to inspect psfn-gateway TESTING_HARNESS_API_KEY wiring: ${deployment_json}"
    return 1
  fi
  if ! TESTING_HARNESS_SECRET_KEY="$(
    printf '%s' "$deployment_json" | node -e '
      const fs = require("node:fs");
      const deployment = JSON.parse(fs.readFileSync(0, "utf8"));
      const containers = deployment.spec?.template?.spec?.containers;
      const gateway = Array.isArray(containers)
        ? containers.find((container) => container?.name === "gateway")
        : undefined;
      const env = Array.isArray(gateway?.env) ? gateway.env : [];
      const ref = env.find((entry) => entry?.name === "TESTING_HARNESS_API_KEY")
        ?.valueFrom?.secretKeyRef;
      if (typeof ref?.key !== "string" || ref.key.trim().length === 0) {
        process.exitCode = 1;
      } else {
        process.stdout.write(ref.key.trim());
      }
    '
  )"; then
    TESTING_HARNESS_KEY_FAILURE="deployment/psfn-gateway does not expose a TESTING_HARNESS_API_KEY secretKeyRef"
    return 1
  fi
  if [[ ! "$TESTING_HARNESS_SECRET_KEY" =~ ^[A-Za-z0-9._-]+$ ]]; then
    TESTING_HARNESS_KEY_FAILURE="deployment/psfn-gateway exposes an invalid TESTING_HARNESS_API_KEY secret key name"
    return 1
  fi
}

report_secret_keys() {
  local names
  if names="$(run_kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" \
    -o 'go-template={{ range $key, $value := .data }}{{ $key }}{{ "\n" }}{{ end }}' 2>/dev/null)"; then
    names="$(printf '%s' "$names" | tr -d '\r' | sort | paste -sd, -)"
  fi
  printf '%s' "${names:-<unreadable>}"
}

load_testing_harness_api_key() {
  resolve_testing_harness_secret_key || return 1

  # 'with' is what makes a missing key readable: a bare
  # '{{ index .data "KEY" }}' renders Go's literal '<no value>' sentinel and
  # exits 0. That sentinel used to reach a lenient base64 decoder, which
  # dropped '<', ' ' and '>' and produced five junk bytes whose UTF-8 decode
  # was U+FFFD mojibake — undici then rejected the Authorization header at the
  # character right after 'Bearer ' (psfn-framework-zu0g5).
  local secret_template
  printf -v secret_template '{{ with index .data "%s" }}{{ . }}{{ end }}' "$TESTING_HARNESS_SECRET_KEY"
  local encoded
  if ! encoded="$(
    run_kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" \
      -o "go-template=${secret_template}" 2>&1
  )"; then
    TESTING_HARNESS_KEY_FAILURE="failed to read ${TESTING_HARNESS_SECRET_KEY} from secret/${SECRET_NAME}: ${encoded}"
    return 1
  fi
  encoded="$(printf '%s' "$encoded" | trim_text)"
  if [[ -z "$encoded" ]]; then
    TESTING_HARNESS_KEY_FAILURE="secret/${SECRET_NAME} has no data.${TESTING_HARNESS_SECRET_KEY} (keys present: $(report_secret_keys)); provision the testing-harness key or the gateway auth checks cannot run"
    return 1
  fi

  local decoded
  if ! decoded="$(
    printf '%s' "$encoded" \
      | SECRET_NAME="$SECRET_NAME" SECRET_KEY="$TESTING_HARNESS_SECRET_KEY" node -e '
const fs = require("node:fs");
const secretName = process.env.SECRET_NAME;
const secretKey = process.env.SECRET_KEY;
const encoded = fs.readFileSync(0, "utf8").trim();

function fail(message) {
  console.error(`secret/${secretName} data.${secretKey} ${message}`);
  process.exit(1);
}

// Decode strictly. Buffer.from(x, "base64") silently discards every character
// it does not recognise, so a non-base64 payload yields plausible-looking
// garbage instead of an error.
if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
  fail("is not canonical base64");
}
const raw = Buffer.from(encoded, "base64");
if (raw.toString("base64") !== encoded) {
  fail("is not canonical base64 (round-trip mismatch)");
}

// A secret written from a CRLF file carries a trailing \r, which is safe to
// strip. Anything else outside printable ASCII is not: the value goes into an
// Authorization header, and undici rejects any header byte above 0xFF while
// bytes 0x00-0x20 would split or truncate the header.
const isAsciiSpace = (byte) => byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20;
let start = 0;
let end = raw.length;
while (start < end && isAsciiSpace(raw[start])) start += 1;
while (end > start && isAsciiSpace(raw[end - 1])) end -= 1;
const value = raw.subarray(start, end);
if (value.length === 0) {
  fail("decodes to an empty value");
}
for (let index = 0; index < value.length; index += 1) {
  const byte = value[index];
  if (byte < 0x21 || byte > 0x7e) {
    fail(
      `decodes to a value that cannot be sent in an HTTP header: byte ${index} is 0x${byte
        .toString(16)
        .padStart(2, "0")}; only printable ASCII 0x21-0x7E is accepted`,
    );
  }
}
process.stdout.write(value.toString("latin1"));
' 2>&1
  )"; then
    TESTING_HARNESS_KEY_FAILURE="$decoded"
    return 1
  fi

  TESTING_HARNESS_API_KEY_VALUE=$decoded
}

check_testing_harness_key() {
  if load_testing_harness_api_key; then
    TESTING_HARNESS_KEY_STATE="ok"
    printf 'testing-harness API key loaded from secret/%s data.%s (%d characters, printable ASCII)\n' \
      "$SECRET_NAME" "$TESTING_HARNESS_SECRET_KEY" "${#TESTING_HARNESS_API_KEY_VALUE}"
    return 0
  fi

  TESTING_HARNESS_KEY_STATE="failed"
  printf '%s\n' "$TESTING_HARNESS_KEY_FAILURE"
  return 1
}

require_testing_harness_key() {
  case "$TESTING_HARNESS_KEY_STATE" in
    ok)
      return 0
      ;;
    failed)
      # The first line lands in the summary, so keep it short and put the full
      # diagnosis (already printed by the "testing-harness key" check) below it.
      printf 'prerequisite "testing-harness key" failed\n'
      printf '%s\n' "$TESTING_HARNESS_KEY_FAILURE"
      return "$CHECK_SKIPPED_STATUS"
      ;;
    *)
      printf 'prerequisite "testing-harness key" did not run\n'
      return "$CHECK_SKIPPED_STATUS"
      ;;
  esac
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
  failures.push(`no app pods matched discovered Deployments: ${deploys.join(", ")}`);
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

check_contract_hash_consistency() {
  # Per-component image tags are allowed to diverge ONLY while every app pod
  # carries the same shared-contract hash (baked at image build). Mixed
  # generations (some images predating the hash file) warn; disagreeing
  # hashes fail.
  local deploy hash
  local -a hashes=()
  local -a missing=()
  for deploy in "${APP_DEPLOYS[@]}"; do
    if hash="$(run_kubectl -n "$NAMESPACE" exec "deploy/${deploy}" -- cat /app/contract-hash.txt 2>/dev/null)"; then
      hash="$(printf '%s' "$hash" | tr -d '[:space:]')"
      hashes+=("${deploy}=${hash}")
    else
      missing+=("$deploy")
    fi
  done
  if [[ ${#hashes[@]} -eq 0 ]]; then
    printf 'no app image carries /app/contract-hash.txt (pre-hash generation); contract agreement was NOT asserted
'
    return 0
  fi
  printf 'contract hashes: %s
' "${hashes[*]}"
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf 'WARNING: components without a contract hash (pre-hash images): %s
' "${missing[*]}"
  fi
  local first="${hashes[0]##*=}" entry
  for entry in "${hashes[@]}"; do
    if [[ "${entry##*=}" != "$first" ]]; then
      printf 'contract hash mismatch across components — per-component tags have split the RPC contract; roll all components to one build
'
      return 1
    fi
  done
  printf 'all components agree on contract hash %s
' "$first"
}

check_garden_pod_readiness() {
  local pods_json
  if ! pods_json="$(run_kubectl -n "$NAMESPACE" get pods -l 'app.kubernetes.io/component=garden' \
    -o json 2>&1)"; then
    printf 'failed to read Garden pod readiness: %s\n' "$pods_json"
    return 1
  fi

  printf '%s' "$pods_json" | node -e '
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const pods = Array.isArray(payload.items) ? payload.items : [];
const failures = [];
for (const pod of pods) {
  const name = String(pod.metadata?.name ?? "<unknown>");
  const conditions = Array.isArray(pod.status?.conditions) ? pod.status.conditions : [];
  const ready = conditions.some(
    condition => condition.type === "Ready" && condition.status === "True",
  );
  if (pod.metadata?.deletionTimestamp) failures.push(`${name}: pod is terminating`);
  if (!ready) failures.push(`${name}: Ready condition is not True`);
}
if (pods.length === 0) failures.push("no Garden pods found");
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Garden pod readiness=True: ${pods.map(pod => pod.metadata?.name).join(", ")}`);
'
}

check_garden_health() {
  case "$GARDEN_HEALTH_CHECK_MODE" in
    pod-readiness)
      check_garden_pod_readiness
      return
      ;;
    http)
      ;;
    *)
      printf 'Garden health check mode is unresolved: %s\n' \
        "${GARDEN_HEALTH_CHECK_MODE:-<missing>}"
      return 1
      ;;
  esac

  local url
  local command
  local response
  local http_status
  local body
  if deploy_binds_host_port psfn-garden; then
    url="http://127.0.0.1:${GARDEN_PORT}/health"
    command="curl -sS --max-time 10 -w '\\n%{http_code}' $(shell_quote "$url")"
    if ! response="$(run_host_shell "$command" 2>&1)"; then
      printf 'garden health curl failed: %s\n' "$response"
      return 1
    fi
  else
    local script
    script=$(cat <<EOS
const res = await fetch("http://127.0.0.1:${GARDEN_PORT}/health");
const body = await res.text();
process.stdout.write(body + "\n" + res.status);
EOS
)
    if ! response="$(run_pod_node psfn-garden "$script" 2>&1)"; then
      printf 'garden health in-pod fetch failed (no hostPort bound): %s\n' "$response"
      return 1
    fi
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
  headers: { authorization: \`Bearer \${process.env.TESTING_HARNESS_API_KEY ?? ""}\` },
});
const body = await res.text();
process.stdout.write(JSON.stringify({ status: res.status, ok: res.ok, body }));
EOF
)
  run_host_node_with_testing_harness_key "$script"
}

check_gateway_models() {
  require_testing_harness_key || return $?

  # No explicit pattern: expect the deployment's own companion id (COMPANION_ID
  # on the gateway container), so the same gate serves every target.
  if [[ -z "$COMPANION_MODEL_PATTERN" ]]; then
    COMPANION_MODEL_PATTERN="$(run_kubectl -n "$NAMESPACE" get deploy psfn-gateway \
      -o 'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="COMPANION_ID")].value}' 2>/dev/null | tr -d '[:space:]')"
    if [[ -z "$COMPANION_MODEL_PATTERN" ]]; then
      printf 'companion pattern not provided and COMPANION_ID not found on the gateway deployment\n'
      return 1
    fi
    verbose_log "companion pattern resolved from deployment: ${COMPANION_MODEL_PATTERN}"
  fi

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
  pattern = new RegExp(process.env.COMPANION_MODEL_PATTERN || "purrsephone", "i");
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

  # Declared local: an undeclared `read` target would leak into the caller's
  # frame and clobber a same-named local there (bash locals are dynamic).
  local status requested_provider actual_provider requested_model actual_model recorded_at_ms
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

check_emosim_service() {
  # Optional: only validated when the emosim deployment exists in the
  # namespace (emosim.enabled=true in the chart). The check asserts the
  # observer-sidecar contract surface: /api/model must expose 17 appraisal
  # dims and 48 emotions.
  if ! run_kubectl -n "$NAMESPACE" get deploy psfn-emosim >/dev/null 2>&1; then
    printf 'emosim is not deployed in namespace %s; the optional sidecar contract was NOT asserted\n' \
      "$NAMESPACE"
    return 0
  fi

  local output
  if ! output="$(run_kubectl -n "$NAMESPACE" rollout status deploy/psfn-emosim "--timeout=${ROLLOUT_TIMEOUT}" 2>&1)"; then
    printf '%s\n' "$output"
    return 1
  fi
  printf '%s\n' "$output"

  local model_json
  if ! model_json="$(run_kubectl -n "$NAMESPACE" exec deploy/psfn-emosim -- python -c 'import urllib.request,sys; sys.stdout.write(urllib.request.urlopen("http://127.0.0.1:17342/api/model", timeout=10).read().decode())' 2>&1)"; then
    printf 'emosim /api/model request failed: %s\n' "$model_json"
    return 1
  fi

  printf '%s' "$model_json" | node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
let payload;
try {
  payload = JSON.parse(raw);
} catch (error) {
  console.error(`emosim /api/model returned invalid JSON: ${error.message}`);
  process.exit(1);
}
const dims = Array.isArray(payload.appraisal_dims) ? payload.appraisal_dims.length : 0;
const emotions = payload.emotions && typeof payload.emotions === "object"
  ? Object.keys(payload.emotions).length
  : 0;
if (dims !== 17 || emotions !== 48) {
  console.error(`emosim model contract mismatch: appraisal_dims=${dims} (want 17) emotions=${emotions} (want 48)`);
  process.exit(1);
}
console.log(`emosim /api/model contract ok: appraisal_dims=${dims} emotions=${emotions}`);
'
}

check_zero_bookkeeping_writes() {
  local discovery_sql
  discovery_sql=$(cat <<'SQL'
select string_agg(
  format(
    'select json_build_object(''schema'', %L, ''count'', count(*)::text)::text from %I.session_messages_projection where author_name in (''CompletionHandoff'',''BackgroundContinuation'')',
    schemaname,
    schemaname
  ),
  E'\nunion all\n'
  order by schemaname
)
from pg_catalog.pg_tables
where tablename = 'session_messages_projection';
SQL
)

  local projection_sql
  if ! projection_sql="$(run_postgres_sql "$discovery_sql" 2>&1)"; then
    printf 'bookkeeping projection schema discovery failed: %s\n' "$projection_sql"
    return 1
  fi
  if [[ -z "$projection_sql" ]]; then
    printf 'no projection found in any schema\n'
    return 1
  fi

  local output
  if ! output="$(run_postgres_sql "$projection_sql" 2>&1)"; then
    printf 'bookkeeping projection query failed: %s\n' "$output"
    return 1
  fi

  local summary
  if ! summary="$(printf '%s\n' "$output" | node -e '
const fs = require("node:fs");
const lines = fs.readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
let results;
try {
  results = lines.map((line) => JSON.parse(line));
} catch (error) {
  console.error(`bookkeeping projection query returned invalid JSON: ${error.message}`);
  process.exit(1);
}
if (results.length === 0) {
  console.error("bookkeeping projection query returned no schema results");
  process.exit(1);
}
for (const result of results) {
  if (
    typeof result.schema !== "string"
    || typeof result.count !== "string"
    || !/^\d+$/.test(result.count)
  ) {
    console.error(`bookkeeping projection query returned an invalid result: ${JSON.stringify(result)}`);
    process.exit(1);
  }
}
const violations = results.filter((result) => result.count !== "0");
if (violations.length > 0) {
  for (const result of violations) {
    console.error(`bookkeeping projection rows present in schema ${result.schema}: ${result.count}`);
  }
  process.exit(1);
}
const schemas = results.map((result) => result.schema).sort();
console.log(`bookkeeping projection rows=0; checked schemas=${schemas.join(", ")}`);
' 2>&1)"; then
    printf '%s\n' "$summary"
    return 1
  fi

  printf '%s\n' "$summary"
}

check_gateway_smoke() {
  require_testing_harness_key || return $?

  local script
  script=$(cat <<EOF
const port = ${GATEWAY_PORT};
const timeoutMs = ${SMOKE_TIMEOUT_SECONDS} * 1000;
const runId = \`kube-rollout-validation-\${Date.now().toString(36)}\`;
const marker = \`rollout-\${Math.random().toString(36).slice(2, 10)}\`;
const baseUrl = \`http://127.0.0.1:\${port}\`;
const authHeaders = { authorization: \`Bearer \${process.env.TESTING_HARNESS_API_KEY ?? ""}\` };

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
  if ! response="$(run_host_node_with_testing_harness_key "$script" 2>&1)"; then
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

# The plan is the gate's documented coverage contract. Every check belongs here
# even when it will not be executed, so the summary can name what was not
# validated instead of silently reporting a shorter run.
build_check_plan() {
  plan_check gate "rollout status" check_rollout_status
  plan_check gate "app pods and images" check_app_pods_and_images
  plan_check gate "contract hash consistency" check_contract_hash_consistency
  plan_check gate "$GARDEN_HEALTH_CHECK_LABEL" check_garden_health
  plan_check scoped "testing-harness key" check_testing_harness_key
  plan_check gate "gateway models" check_gateway_models
  plan_check gate "postgres pgvector and redis" check_postgres_and_redis
  plan_check gate "agent log scan" check_agent_logs
  if [[ "$SMOKE" == true ]]; then
    plan_check gate "gateway chat smoke" check_gateway_smoke
  fi
  if [[ "$CHECK_PROVIDER_ROUTING" == true ]]; then
    plan_check gate "provider routing" check_provider_routing
  else
    plan_requested_skip "provider routing" check_provider_routing
  fi
  plan_check gate "zero bookkeeping writes" check_zero_bookkeeping_writes
  plan_check gate "emosim service (optional)" check_emosim_service
}

main() {
  parse_args "$@"
  select_kube_mode
  discover_app_deployments
  if [[ "$LIST_APP_DEPLOYMENTS" == true ]]; then
    printf '%s\n' "${APP_DEPLOYS[@]}"
    exit 0
  fi
  resolve_garden_health_check_mode || die "Garden health check mode could not be resolved"

  printf 'PSFN kube rollout validation\n'
  printf 'namespace=%s mode=%s host=%s rollout_timeout=%s log_since=%s\n' \
    "$NAMESPACE" "$KUBE_MODE" "$HOST_ALIAS" "$ROLLOUT_TIMEOUT" "$SINCE_WINDOW"
  if [[ -n "$EXPECT_TAG" ]]; then
    printf 'expect_tag=%s\n' "$EXPECT_TAG"
  fi

  build_check_plan
  printf 'planned checks (%d):\n' "$(planned_check_total)"
  printf '  - %s\n' "${PLANNED_CHECK_NAMES[@]}"
  run_check_plan

  print_summary
  # Skipped and not-run checks validated nothing, so they must never leave the
  # gate looking successful. Operator-requested skips are deliberate and are
  # reported without failing the run.
  if ((FAIL_COUNT > 0 || SKIP_COUNT > 0 || NOT_RUN_COUNT > 0)); then
    exit 1
  fi
}

main "$@"
