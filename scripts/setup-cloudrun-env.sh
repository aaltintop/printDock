#!/usr/bin/env bash

# Usage:
#   source scripts/setup-cloudrun-env.sh
#   source scripts/setup-cloudrun-env.sh --non-interactive
#
# This script sets and exports deployment variables used for Cloud Run.
# Source it (not run it) so exports persist in your current shell.

is_sourced=0
if [[ -n "${BASH_VERSION:-}" ]]; then
  [[ "${BASH_SOURCE[0]}" != "$0" ]] && is_sourced=1
  script_path="${BASH_SOURCE[0]}"
elif [[ -n "${ZSH_VERSION:-}" ]]; then
  [[ "${(%):-%N}" != "$0" ]] && is_sourced=1
  script_path="${(%):-%N}"
else
  script_path="$0"
fi

die() {
  local msg="$1"
  echo "$msg"
  if [[ "$is_sourced" == "1" ]]; then
    return 1
  fi
  exit 1
}

PROJECT_ROOT="$(cd "$(dirname "$script_path")/.." && pwd)"
LOCAL_ENV_FILE="$PROJECT_ROOT/.env"
OUTPUT_ENV_FILE="$PROJECT_ROOT/.cloudrun.env"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "Missing required command: $cmd"
  fi
}

read_from_local_env() {
  local key="$1"
  if [[ -f "$LOCAL_ENV_FILE" ]]; then
    # shellcheck disable=SC2002
    local value
    value="$(grep -E "^${key}=" "$LOCAL_ENV_FILE" | head -n 1 | cut -d'=' -f2- || true)"
    printf "%s" "${value:-}"
  fi
}

prompt_value() {
  local var_name="$1"
  local prompt_text="$2"
  local default_value="${3:-}"
  local input_value=""

  if [[ "${NON_INTERACTIVE:-0}" == "1" ]]; then
    printf -v "$var_name" "%s" "$default_value"
    return
  fi

  if [[ -n "$default_value" ]]; then
    printf "%s" "$prompt_text [$default_value]: "
    read -r input_value || true
    case "$input_value" in
      q|Q|quit|QUIT|exit|EXIT) die "Cancelled by user." ;;
    esac
    input_value="${input_value:-$default_value}"
  else
    printf "%s" "$prompt_text: "
    read -r input_value || true
    case "$input_value" in
      q|Q|quit|QUIT|exit|EXIT) die "Cancelled by user." ;;
    esac
  fi

  printf -v "$var_name" "%s" "$input_value"
}

assert_not_empty() {
  local key="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    die "Required value is empty: $key"
  fi
}

NON_INTERACTIVE=0
if [[ "${1:-}" == "--non-interactive" ]]; then
  NON_INTERACTIVE=1
fi

require_cmd gcloud

DEFAULT_PROJECT_ID="${PROJECT_ID:-$(read_from_local_env FIREBASE_PROJECT_ID)}"
DEFAULT_FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-$(read_from_local_env FIREBASE_PROJECT_ID)}"
DEFAULT_FIREBASE_STORAGE_BUCKET="${FIREBASE_STORAGE_BUCKET:-$(read_from_local_env FIREBASE_STORAGE_BUCKET)}"
DEFAULT_SERVICE_NAME="${SERVICE_NAME:-printdock-service}"
DEFAULT_SERVICE_REGION="${SERVICE_REGION:-europe-west1}"

if [[ "${NON_INTERACTIVE:-0}" != "1" ]]; then
  cat <<EOF
Cloud Run environment setup
---------------------------
- Press Enter to accept defaults shown in [brackets]
- Type q / quit / exit at any prompt to cancel
- This script updates the active gcloud project and exports vars in current shell
EOF
fi

prompt_value PROJECT_ID "GCP Project ID" "$DEFAULT_PROJECT_ID"
prompt_value SERVICE_NAME "Cloud Run service name" "$DEFAULT_SERVICE_NAME"
prompt_value SERVICE_REGION "Cloud Run region" "$DEFAULT_SERVICE_REGION"
prompt_value FIREBASE_PROJECT_ID "Firebase project ID" "$DEFAULT_FIREBASE_PROJECT_ID"
prompt_value FIREBASE_STORAGE_BUCKET "Firebase Storage bucket" "$DEFAULT_FIREBASE_STORAGE_BUCKET"

assert_not_empty PROJECT_ID "$PROJECT_ID"
assert_not_empty SERVICE_NAME "$SERVICE_NAME"
assert_not_empty SERVICE_REGION "$SERVICE_REGION"
assert_not_empty FIREBASE_PROJECT_ID "$FIREBASE_PROJECT_ID"
assert_not_empty FIREBASE_STORAGE_BUCKET "$FIREBASE_STORAGE_BUCKET"

gcloud config set project "$PROJECT_ID" >/dev/null

export PROJECT_ID
export SERVICE_NAME
export SERVICE_REGION
export FIREBASE_PROJECT_ID
export FIREBASE_STORAGE_BUCKET

cat >"$OUTPUT_ENV_FILE" <<EOF
export PROJECT_ID="$PROJECT_ID"
export SERVICE_NAME="$SERVICE_NAME"
export SERVICE_REGION="$SERVICE_REGION"
export FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID"
export FIREBASE_STORAGE_BUCKET="$FIREBASE_STORAGE_BUCKET"
EOF

cat <<EOF
Cloud Run variables exported in current shell:
  PROJECT_ID=$PROJECT_ID
  SERVICE_NAME=$SERVICE_NAME
  SERVICE_REGION=$SERVICE_REGION
  FIREBASE_PROJECT_ID=$FIREBASE_PROJECT_ID
  FIREBASE_STORAGE_BUCKET=$FIREBASE_STORAGE_BUCKET

Saved reusable exports to:
  $OUTPUT_ENV_FILE

Tip:
  source "$OUTPUT_ENV_FILE"
EOF
