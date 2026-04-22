#!/usr/bin/env bash
set -euo pipefail

# Two-phase Cloud Run deploy for Shopify app:
# 1) Deploy without SHOPIFY_APP_URL to create/get service URL
# 2) Deploy again with SHOPIFY_APP_URL set
#
# Expected env vars (auto-loaded from repo-root .cloudrun.env if PROJECT_ID is unset,
# or set manually / via: source .cloudrun.env):
#   PROJECT_ID
#   SERVICE_NAME
#   SERVICE_REGION
#   FIREBASE_PROJECT_ID
#   FIREBASE_STORAGE_BUCKET
#   SCOPES
#
# Secret behavior:
# - Uses Secret Manager secrets `shopify-api-key` and `shopify-api-secret`
# - If secrets do not exist, creates them from SHOPIFY_API_KEY / SHOPIFY_API_SECRET env vars.
# - If secrets exist and env vars are set, rotates by adding a new secret version.
#
# After deploy, optional interactive next steps (stdin/stdout must be a TTY):
# - Offer to patch shopify.app.toml (application_url, [auth].redirect_urls, [app_proxy].url)
# - Offer to run: shopify app deploy
# Set DEPLOY_NON_INTERACTIVE=1 (or run with piped/non-TTY stdin) to skip prompts and only print hints.

SECRET_API_KEY_NAME="${SECRET_API_KEY_NAME:-shopify-api-key}"
SECRET_API_SECRET_NAME="${SECRET_API_SECRET_NAME:-shopify-api-secret}"
PORT="${PORT:-8080}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"
ALLOW_UNAUTH="${ALLOW_UNAUTH:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLOUDRUN_ENV_FILE="$REPO_ROOT/.cloudrun.env"
# Allow running the script without `source .cloudrun.env` first (common mistake).
if [[ -z "${PROJECT_ID:-}" && -f "$CLOUDRUN_ENV_FILE" ]]; then
  echo "Loading Cloud Run defaults from .cloudrun.env"
  set -a
  # shellcheck disable=SC1090
  source "$CLOUDRUN_ENV_FILE"
  set +a
fi

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
}

require_env() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    echo "Missing required env var: $key"
    if [[ ! -f "$CLOUDRUN_ENV_FILE" ]]; then
      echo "Create $CLOUDRUN_ENV_FILE by running: source scripts/setup-cloudrun-env.sh"
    else
      echo "From repo root run: source .cloudrun.env"
      echo "You still need Shopify scopes in the shell, e.g.: eval \"\$(shopify app info --web-env)\""
    fi
    exit 1
  fi
}

secret_exists() {
  local secret_name="$1"
  gcloud secrets describe "$secret_name" >/dev/null 2>&1
}

create_or_rotate_secret() {
  local secret_name="$1"
  local secret_value="$2"

  if secret_exists "$secret_name"; then
    if [[ -n "$secret_value" ]]; then
      echo "Rotating secret version: $secret_name"
      printf "%s" "$secret_value" | gcloud secrets versions add "$secret_name" --data-file=-
    else
      echo "Secret exists, keeping current latest: $secret_name"
    fi
  else
    if [[ -z "$secret_value" ]]; then
      echo "Secret $secret_name does not exist and corresponding value is missing in env."
      echo "Set required env var and re-run."
      exit 1
    fi
    echo "Creating secret: $secret_name"
    printf "%s" "$secret_value" | gcloud secrets create "$secret_name" --data-file=-
  fi
}

is_interactive_shell() {
  if [[ -n "${DEPLOY_NON_INTERACTIVE:-}" ]]; then
    return 1
  fi
  [[ -t 0 ]] && [[ -t 1 ]]
}

prompt_yes() {
  local prompt="$1"
  local reply
  read -r -p "$prompt [y/N] " reply || return 1
  [[ "$reply" =~ ^[yY]([eE][sS])?$ ]]
}

# Updates shopify.app.toml to match Cloud Run's public URL (requires perl).
patch_shopify_app_toml() {
  local base_url="${1:?}"
  local toml="$REPO_ROOT/shopify.app.toml"
  local auth_url="${base_url}/api/auth"

  if [[ ! -f "$toml" ]]; then
    echo "Error: missing $toml"
    return 1
  fi
  if ! command -v perl >/dev/null 2>&1; then
    echo "Error: perl not found; install perl or update shopify.app.toml manually."
    return 1
  fi

  SHOPIFY_PATCH_BASE_URL="$base_url" SHOPIFY_PATCH_AUTH_URL="$auth_url" perl -i -pe '
    if (/^\[app_proxy\]/) { $ap = 1 }
    elsif (/^\[/ && !/^\[app_proxy\]/) { $ap = 0 }
    elsif (/^application_url = /) { s|^application_url = ".*"|application_url = "$ENV{SHOPIFY_PATCH_BASE_URL}"| }
    elsif (/^redirect_urls = /) { s|^redirect_urls = \[ ".*" \]|redirect_urls = [ "$ENV{SHOPIFY_PATCH_AUTH_URL}" ]| }
    elsif ($ap && /^url = /) { s|^url = ".*"|url = "$ENV{SHOPIFY_PATCH_BASE_URL}"| }
  ' -- "$toml"

  echo "Patched $toml (application_url, redirect_urls, [app_proxy].url)."
}

deploy_base() {
  local include_shopify_url="$1" # 0 or 1
  local env_file
  env_file="$(mktemp)"
  trap 'rm -f "$env_file"' RETURN

  {
    echo "SCOPES: \"$SCOPES\""
    echo "NODE_ENV: \"production\""
    echo "LOG_LEVEL: \"${LOG_LEVEL:-info}\""
    echo "FIREBASE_PROJECT_ID: \"$FIREBASE_PROJECT_ID\""
    echo "FIREBASE_STORAGE_BUCKET: \"$FIREBASE_STORAGE_BUCKET\""
    if [[ "$include_shopify_url" == "1" ]]; then
      echo "SHOPIFY_APP_URL: \"$SHOPIFY_APP_URL\""
    else
      # Shopify app package crashes if SHOPIFY_APP_URL is completely empty on boot
      echo "SHOPIFY_APP_URL: \"https://temporary-placeholder.example.com\""
    fi
  } >"$env_file"

  local cmd=(
    gcloud run deploy "$SERVICE_NAME"
    --source .
    --region "$SERVICE_REGION"
    --set-secrets "SHOPIFY_API_KEY=${SECRET_API_KEY_NAME}:latest,SHOPIFY_API_SECRET=${SECRET_API_SECRET_NAME}:latest"
    --env-vars-file "$env_file"
    --port "$PORT"
    --min-instances "$MIN_INSTANCES"
  )

  if [[ "$ALLOW_UNAUTH" == "1" ]]; then
    cmd+=(--allow-unauthenticated)
  fi

  "${cmd[@]}"
}

require_cmd gcloud
require_env PROJECT_ID
require_env SERVICE_NAME
require_env SERVICE_REGION
require_env FIREBASE_PROJECT_ID
require_env FIREBASE_STORAGE_BUCKET
require_env SCOPES

cd "$REPO_ROOT"

gcloud config set project "$PROJECT_ID" >/dev/null

create_or_rotate_secret "$SECRET_API_KEY_NAME" "${SHOPIFY_API_KEY:-}"
create_or_rotate_secret "$SECRET_API_SECRET_NAME" "${SHOPIFY_API_SECRET:-}"

echo "Phase 1/2: deploy without SHOPIFY_APP_URL"
deploy_base 0

export SHOPIFY_APP_URL
SHOPIFY_APP_URL="$(gcloud run services describe "$SERVICE_NAME" --region "$SERVICE_REGION" --format='value(status.url)')"
if [[ -z "$SHOPIFY_APP_URL" ]]; then
  echo "Failed to resolve SHOPIFY_APP_URL from Cloud Run service."
  exit 1
fi
echo "Resolved SHOPIFY_APP_URL=$SHOPIFY_APP_URL"

echo "Phase 2/2: deploy with SHOPIFY_APP_URL"
deploy_base 1

# URL can change to the regional hostname (e.g. *.us-central1.run.app) after the second deploy;
# re-read so "Next steps" matches what Cloud Run reports.
SHOPIFY_APP_URL="$(gcloud run services describe "$SERVICE_NAME" --region "$SERVICE_REGION" --format='value(status.url)')"
if [[ -z "$SHOPIFY_APP_URL" ]]; then
  echo "Failed to re-resolve SHOPIFY_APP_URL after phase 2."
  exit 1
fi
echo "Final SHOPIFY_APP_URL=$SHOPIFY_APP_URL"

cat <<EOF
Two-phase deploy completed.

Next steps:
1) Update shopify.app.toml with:
   - application_url = "$SHOPIFY_APP_URL"
   - [auth] redirect_urls includes "$SHOPIFY_APP_URL/api/auth"
   - [app_proxy] url = "$SHOPIFY_APP_URL"
2) Run: shopify app deploy
3) Reinstall app on target store if URL changed.
EOF

if is_interactive_shell; then
  echo ""
  if prompt_yes "Patch shopify.app.toml to the Final SHOPIFY_APP_URL above?"; then
    patch_shopify_app_toml "$SHOPIFY_APP_URL" || true
  fi
  if prompt_yes "Run shopify app deploy now (pushes TOML + extensions to Shopify)?"; then
    if command -v shopify >/dev/null 2>&1; then
      (cd "$REPO_ROOT" && shopify app deploy) || echo "shopify app deploy exited non-zero; fix errors and re-run."
    else
      echo "shopify CLI not found in PATH; run: shopify app deploy"
    fi
  fi
  echo ""
  echo "Reminder: if the app URL changed for a store, merchants may need to re-open or reinstall the app."
else
  echo ""
  echo "(Non-interactive session: skipped prompts. Use a TTY without DEPLOY_NON_INTERACTIVE, or patch shopify.app.toml / run shopify app deploy yourself.)"
fi
