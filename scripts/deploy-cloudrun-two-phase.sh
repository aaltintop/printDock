#!/usr/bin/env bash
set -euo pipefail

# PrintDock deploy helper.
#
# Pick what you actually need — the original script always did a full
# two-phase Cloud Run deploy (~10 min) even when nothing on the server changed.
# This version offers focused modes and skips the legacy Phase 1 step
# automatically once the Cloud Run service exists.
#
# Modes (pick one via --mode=<key>, DEPLOY_MODE env, or interactive menu):
#
#   ext         Extensions only — runs `shopify app deploy` (~60-90s).
#               Use when you only changed extensions/** , shopify.app.toml,
#               or scopes. No Cloud Build, no Docker rebuild.
#
#   backend     Backend only — Cloud Run deploy. Auto-skips the legacy Phase 1
#               (placeholder SHOPIFY_APP_URL) when the service already exists,
#               cutting deploy time roughly in half (~3-5 min instead of 8-10).
#               Use when you only changed app/**, Dockerfile, package*.json,
#               or .cloudrun.env.
#
#   full        Backend + extensions in order. Use when both server-side code
#               and extensions/scopes changed.
#
#   first-time  Force the original two-phase + extensions flow. Use only when
#               (re)creating the Cloud Run service, or after a URL change
#               where the embedded app needs the placeholder bootstrap.
#
#   patch-toml  Rewrite shopify.app.toml URLs (application_url, redirect_urls,
#               [app_proxy].url) to the current Cloud Run URL and exit.
#               No deploy, no extension push.
#
#   status      Print Cloud Run service URL + latest revision and exit.
#
# Expected env vars (auto-loaded from repo-root .cloudrun.env if PROJECT_ID
# is unset):
#   PROJECT_ID, SERVICE_NAME, SERVICE_REGION, FIREBASE_PROJECT_ID,
#   FIREBASE_STORAGE_BUCKET, SCOPES
#   RUNTIME_SERVICE_ACCOUNT  (optional; defaults to
#                             printdock-run@<project>.iam.gserviceaccount.com.
#                             Must exist with Firestore + Storage + Secret
#                             + signBlob roles — see
#                             docs/DEPLOY_CLOUD_RUN.md Step 3a.)
#
# Secret behavior:
#   - Uses Secret Manager secrets `shopify-api-key` / `shopify-api-secret`.
#   - Creates them from SHOPIFY_API_KEY / SHOPIFY_API_SECRET if missing.
#   - Adds a new secret version when those env vars are set on a deploy run.
#
# Non-interactive use:
#   - Pass --mode=<key> or set DEPLOY_MODE=<key> to skip the menu.
#   - DEPLOY_NON_INTERACTIVE=1 (or piped stdin) defaults to mode 'backend'
#     when --mode is not supplied.
#   - --yes / -y or DEPLOY_ASSUME_YES=1:
#       - After Cloud Run deploy, patch shopify.app.toml without prompting.
#       - Run shopify app deploy with --allow-updates --allow-deletes so the
#         CLI does not ask to release the new version (same idea as deprecated
#         --force; safe for scripted deploys when you intend to ship).

SECRET_API_KEY_NAME="${SECRET_API_KEY_NAME:-shopify-api-key}"
SECRET_API_SECRET_NAME="${SECRET_API_SECRET_NAME:-shopify-api-secret}"
PORT="${PORT:-8080}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"
ALLOW_UNAUTH="${ALLOW_UNAUTH:-1}"

# Cached-build settings. Set DEPLOY_USE_CACHE=0 to fall back to the legacy
# `gcloud run deploy --source .` path (no Kaniko cache). Useful as an escape
# hatch if the Cloud Build / Kaniko config breaks.
DEPLOY_USE_CACHE="${DEPLOY_USE_CACHE:-1}"
AR_REPO="${AR_REPO:-printdock-images}"
CLOUDBUILD_CONFIG="${CLOUDBUILD_CONFIG:-cloudbuild.yaml}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLOUDRUN_ENV_FILE="$REPO_ROOT/.cloudrun.env"

# ---------------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------------

usage() {
  cat <<'EOF'
Usage: scripts/deploy-cloudrun-two-phase.sh [--mode=<mode>] [--yes] [--help]

Modes:
  ext         Extensions only ('shopify app deploy', ~60-90s)
  backend     Backend only (Cloud Run; auto-skips Phase 1 if service exists)
  full        Backend + extensions
  first-time  Force two-phase + extensions (use to (re)create the service)
  patch-toml  Rewrite shopify.app.toml URLs to current Cloud Run URL
  status      Print Cloud Run service URL + latest revision

If --mode is omitted and stdin is a TTY, an interactive menu is shown.
DEPLOY_MODE=<mode> env var is honored if --mode is omitted.
DEPLOY_NON_INTERACTIVE=1 forces non-interactive (defaults to 'backend').

  --yes, -y       Auto-accept post-deploy TOML patch and non-interactive
                  shopify app deploy (sets DEPLOY_ASSUME_YES=1). Equivalent
                  env: DEPLOY_ASSUME_YES=1.

Build:
  Cloud Build + Kaniko cache is used by default (npm ci becomes a cache hit
  when package-lock.json is unchanged, dropping deploys to ~2-3 min).
  Set DEPLOY_USE_CACHE=0 to fall back to 'gcloud run deploy --source .'.
  Override AR_REPO (default: printdock-images) and CLOUDBUILD_CONFIG
  (default: cloudbuild.yaml) if needed.
EOF
}

MODE="${DEPLOY_MODE:-}"
for arg in "$@"; do
  case "$arg" in
    --mode=*) MODE="${arg#--mode=}" ;;
    --yes|-y) DEPLOY_ASSUME_YES=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

# Allow running the script without `source .cloudrun.env` first (common mistake).
# Done after arg parsing so --help / unknown-arg paths stay quiet.
if [[ -z "${PROJECT_ID:-}" && -f "$CLOUDRUN_ENV_FILE" ]]; then
  echo "Loading Cloud Run defaults from .cloudrun.env"
  set -a
  # shellcheck disable=SC1090
  source "$CLOUDRUN_ENV_FILE"
  set +a
fi

# ---------------------------------------------------------------------------
# Generic helpers (preserved from the original script)
# ---------------------------------------------------------------------------

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

require_env() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    echo "Missing required env var: $key" >&2
    if [[ ! -f "$CLOUDRUN_ENV_FILE" ]]; then
      echo "Create $CLOUDRUN_ENV_FILE by running: source scripts/setup-cloudrun-env.sh" >&2
    else
      echo "From repo root run: source .cloudrun.env" >&2
      echo "You still need Shopify scopes in the shell, e.g.: eval \"\$(shopify app info --web-env)\"" >&2
    fi
    exit 1
  fi
}

preflight_theme_asset_syntax() {
  local theme_asset="$REPO_ROOT/extensions/theme-extension/assets/upload.js"
  if [[ ! -f "$theme_asset" ]]; then
    echo "WARNING: Theme upload asset not found at $theme_asset; skipping JS syntax preflight."
    return 0
  fi
  if ! node --check "$theme_asset"; then
    echo "ERROR: JavaScript syntax check failed for $theme_asset" >&2
    echo "Fix the syntax error above before deploying." >&2
    exit 1
  fi
  echo "Preflight passed: upload.js syntax is valid."
}

secret_exists() {
  local secret_name="$1"
  gcloud secrets describe "$secret_name" >/dev/null 2>&1
}

active_gcloud_account() {
  gcloud config get-value account 2>/dev/null || true
}

service_account_exists() {
  local sa_email="$1"
  gcloud iam service-accounts describe "$sa_email" --project "$PROJECT_ID" >/dev/null 2>&1
}

sa_has_role_on_self() {
  local sa_email="$1" member="$2" role="$3"
  gcloud iam service-accounts get-iam-policy "$sa_email" \
    --project "$PROJECT_ID" \
    --flatten="bindings[].members" \
    --filter="bindings.role=$role AND bindings.members=$member" \
    --format="value(bindings.role)" 2>/dev/null | grep -q "$role"
}

project_has_role() {
  local member="$1" role="$2"
  gcloud projects get-iam-policy "$PROJECT_ID" \
    --flatten="bindings[].members" \
    --filter="bindings.role=$role AND bindings.members=$member" \
    --format="value(bindings.role)" 2>/dev/null | grep -q "$role"
}

member_can_access_secret() {
  local member="$1" secret_name="$2"
  if project_has_role "$member" "roles/secretmanager.secretAccessor"; then
    return 0
  fi
  gcloud secrets get-iam-policy "$secret_name" \
    --project "$PROJECT_ID" \
    --flatten="bindings[].members" \
    --filter="bindings.role=roles/secretmanager.secretAccessor AND bindings.members=$member" \
    --format="value(bindings.role)" 2>/dev/null | grep -q "roles/secretmanager.secretAccessor"
}

preflight_runtime_service_account() {
  local sa_email="$1"
  local active_account
  active_account="$(active_gcloud_account)"

  if ! service_account_exists "$sa_email"; then
    echo "ERROR: Runtime service account does not exist: $sa_email" >&2
    echo "Create it with:" >&2
    echo "  gcloud iam service-accounts create ${sa_email%@*} \\" >&2
    echo "    --display-name=\"PrintDock Cloud Run runtime\" \\" >&2
    echo "    --project=\"$PROJECT_ID\"" >&2
    echo "" >&2
    echo "Then follow docs/DEPLOY_CLOUD_RUN.md Step 3a to grant the required roles." >&2
    exit 1
  fi

  if [[ -n "$active_account" ]]; then
    if ! sa_has_role_on_self "$sa_email" "user:$active_account" "roles/iam.serviceAccountUser" \
      && ! project_has_role "user:$active_account" "roles/iam.serviceAccountUser"; then
      echo "ERROR: Active account '$active_account' is missing 'roles/iam.serviceAccountUser' on '$sa_email'." >&2
      echo "Cloud Run needs this so you can deploy revisions that run as the SA." >&2
      echo "Grant it with:" >&2
      echo "  gcloud iam service-accounts add-iam-policy-binding \"$sa_email\" \\" >&2
      echo "    --member=\"user:$active_account\" \\" >&2
      echo "    --role=\"roles/iam.serviceAccountUser\" \\" >&2
      echo "    --project=\"$PROJECT_ID\"" >&2
      exit 1
    fi
  else
    echo "WARNING: Could not resolve active gcloud account; skipping actAs check." >&2
  fi
}

preflight_runtime_secret_access() {
  local sa_email="$1"
  shift
  local secret member missing=0
  member="serviceAccount:$sa_email"
  for secret in "$@"; do
    if ! secret_exists "$secret"; then
      continue
    fi
    if ! member_can_access_secret "$member" "$secret"; then
      echo "ERROR: Runtime SA '$sa_email' is missing 'roles/secretmanager.secretAccessor' on secret '$secret'." >&2
      echo "Grant it with:" >&2
      echo "  gcloud secrets add-iam-policy-binding \"$secret\" \\" >&2
      echo "    --member=\"$member\" \\" >&2
      echo "    --role=\"roles/secretmanager.secretAccessor\" \\" >&2
      echo "    --project=\"$PROJECT_ID\"" >&2
      missing=1
    fi
  done
  if [[ "$missing" -eq 1 ]]; then
    echo "" >&2
    echo "Or grant project-wide once (matches docs/DEPLOY_CLOUD_RUN.md Step 3a):" >&2
    echo "  gcloud projects add-iam-policy-binding \"$PROJECT_ID\" \\" >&2
    echo "    --member=\"$member\" \\" >&2
    echo "    --role=\"roles/secretmanager.secretAccessor\"" >&2
    exit 1
  fi
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
      echo "Secret $secret_name does not exist and corresponding value is missing in env." >&2
      echo "Set required env var and re-run." >&2
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

# ---------------------------------------------------------------------------
# Deploy primitives
# ---------------------------------------------------------------------------

# Updates shopify.app.toml to match Cloud Run's public URL (requires perl).
patch_shopify_app_toml() {
  local base_url="${1:?}"
  local toml="$REPO_ROOT/shopify.app.toml"
  local auth_url="${base_url}/auth/callback"

  if [[ ! -f "$toml" ]]; then
    echo "Error: missing $toml" >&2
    return 1
  fi
  if ! command -v perl >/dev/null 2>&1; then
    echo "Error: perl not found; install perl or update shopify.app.toml manually." >&2
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

# Returns 0 and echoes the URL if the Cloud Run service already exists.
# Returns 1 (no output) otherwise.
resolve_existing_service_url() {
  local url
  url="$(gcloud run services describe "$SERVICE_NAME" \
    --region "$SERVICE_REGION" \
    --format='value(status.url)' 2>/dev/null || true)"
  if [[ -n "$url" ]]; then
    echo "$url"
    return 0
  fi
  return 1
}

# Ensure the Artifact Registry repo exists for Kaniko-cached image builds,
# and that the Cloud Build SA can push to it and the Cloud Run runtime SA
# can pull from it. Without these IAM bindings, brand-new repos cause
# Kaniko's push to fail silently and Cloud Build then reports the misleading
# "Image(s) could not be found" post-step error.
ensure_artifact_registry_repo() {
  local repo="$1" region="$2"
  if ! gcloud artifacts repositories describe "$repo" \
    --location="$region" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "Creating Artifact Registry repo '$repo' in $region (one-time setup)..."
    gcloud artifacts repositories create "$repo" \
      --repository-format=docker \
      --location="$region" \
      --description="PrintDock Cloud Run images + Kaniko build cache" \
      --project="$PROJECT_ID"
  fi

  local project_number
  project_number="$(gcloud projects describe "$PROJECT_ID" \
    --format='value(projectNumber)' 2>/dev/null || true)"
  if [[ -z "$project_number" ]]; then
    echo "WARNING: Could not resolve project number; skipping AR IAM grants." >&2
    return 0
  fi
  local cloudbuild_sa="${project_number}@cloudbuild.gserviceaccount.com"

  ensure_ar_repo_role "$repo" "$region" \
    "serviceAccount:${cloudbuild_sa}" "roles/artifactregistry.writer"
  ensure_ar_repo_role "$repo" "$region" \
    "serviceAccount:${RUNTIME_SERVICE_ACCOUNT}" "roles/artifactregistry.reader"
}

# Tracks whether ensure_ar_repo_role granted anything in this session, so we
# can wait once for IAM eventual consistency before kicking off Cloud Build.
AR_REPO_IAM_CHANGED=0

# Idempotent helper that adds an IAM binding on the AR repo only if missing.
ensure_ar_repo_role() {
  local repo="$1" region="$2" member="$3" role="$4"
  if gcloud artifacts repositories get-iam-policy "$repo" \
    --location="$region" --project="$PROJECT_ID" \
    --flatten="bindings[].members" \
    --filter="bindings.role=${role} AND bindings.members=${member}" \
    --format="value(bindings.role)" 2>/dev/null | grep -q "$role"; then
    return 0
  fi
  echo "Granting ${role} to ${member} on AR repo ${repo}..."
  gcloud artifacts repositories add-iam-policy-binding "$repo" \
    --location="$region" \
    --project="$PROJECT_ID" \
    --member="$member" \
    --role="$role" >/dev/null
  AR_REPO_IAM_CHANGED=1
}

# Build a container image with Cloud Build + Kaniko using the persistent
# layer cache stored in Artifact Registry. Echoes the resolved image
# reference (region-docker.pkg.dev/.../service:tag) on success.
build_image_with_cache() {
  local tag region_short="${SERVICE_REGION%%-*}"
  if command -v git >/dev/null 2>&1 \
    && git -C "$REPO_ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
    tag="$(git -C "$REPO_ROOT" rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
  else
    tag="$(date -u +%Y%m%d%H%M%S)"
  fi

  ensure_artifact_registry_repo "$AR_REPO" "$SERVICE_REGION" >&2

  if [[ "$AR_REPO_IAM_CHANGED" == "1" ]]; then
    echo "Waiting 10s for AR IAM bindings to propagate before kicking off Cloud Build..." >&2
    sleep 10
  fi

  local image_ref="${SERVICE_REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}:${tag}"

  if [[ ! -f "$REPO_ROOT/$CLOUDBUILD_CONFIG" ]]; then
    echo "ERROR: Missing $CLOUDBUILD_CONFIG at repo root. Restore it or set DEPLOY_USE_CACHE=0." >&2
    exit 1
  fi

  echo "==> Building image with Cloud Build + Kaniko cache" >&2
  echo "    Repo:  $AR_REPO ($SERVICE_REGION)" >&2
  echo "    Tag:   $tag" >&2
  echo "    Cache: ${SERVICE_REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}/cache" >&2

  ( cd "$REPO_ROOT" && gcloud builds submit \
    --config="$CLOUDBUILD_CONFIG" \
    --substitutions="_SERVICE=${SERVICE_NAME},_REGION=${SERVICE_REGION},_AR_REPO=${AR_REPO},_TAG=${tag}" \
    --project="$PROJECT_ID" >&2 ) || return 1

  echo "$image_ref"
}

# `gcloud run deploy` invocation. $1 = include SHOPIFY_APP_URL (0 or 1).
# When DEPLOY_USE_CACHE=1 (default) it builds the image first via
# build_image_with_cache and deploys with --image. When DEPLOY_USE_CACHE=0
# it falls back to the legacy `gcloud run deploy --source .` path.
deploy_base() {
  local include_shopify_url="$1"
  local env_file
  env_file="$(mktemp)"
  # NOTE: bash's `RETURN` trap is GLOBAL once installed inside a function:
  # it fires on every subsequent function return until cleared. We embed the
  # actual temp path into the trap (so it survives the local variable going
  # out of scope) and self-clear the trap inside its own body, so it runs
  # exactly once for THIS deploy_base invocation. Without this, the trap
  # would later fire on unrelated function returns (e.g. after the
  # interactive "Patch shopify.app.toml?" prompt), where $env_file is no
  # longer bound and `set -u` aborts the script just before
  # `shopify app deploy` would have run.
  trap "rm -f '$env_file'; trap - RETURN" RETURN

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
    --region "$SERVICE_REGION"
    --set-secrets "SHOPIFY_API_KEY=${SECRET_API_KEY_NAME}:latest,SHOPIFY_API_SECRET=${SECRET_API_SECRET_NAME}:latest"
    --env-vars-file "$env_file"
    --port "$PORT"
    --min-instances "$MIN_INSTANCES"
    --service-account "$RUNTIME_SERVICE_ACCOUNT"
  )

  if [[ "$ALLOW_UNAUTH" == "1" ]]; then
    cmd+=(--allow-unauthenticated)
  fi

  if [[ "$DEPLOY_USE_CACHE" == "1" ]]; then
    if [[ -z "${SESSION_IMAGE_REF:-}" ]]; then
      if ! SESSION_IMAGE_REF="$(build_image_with_cache)"; then
        echo "ERROR: Cached image build failed." >&2
        echo "       Set DEPLOY_USE_CACHE=0 to fall back to 'gcloud run deploy --source .'." >&2
        exit 1
      fi
      export SESSION_IMAGE_REF
      echo "==> Built image $SESSION_IMAGE_REF (reused for any further deploys this session)"
    else
      echo "==> Reusing image $SESSION_IMAGE_REF (built earlier in this session)"
    fi
    cmd+=(--image "$SESSION_IMAGE_REF")
  else
    cmd+=(--source .)
  fi

  "${cmd[@]}"
}

# Run preflights that only matter for a Cloud Run deploy.
prepare_cloudrun_env() {
  require_cmd gcloud
  require_cmd node
  require_env PROJECT_ID
  require_env SERVICE_NAME
  require_env SERVICE_REGION
  require_env FIREBASE_PROJECT_ID
  require_env FIREBASE_STORAGE_BUCKET
  require_env SCOPES

  cd "$REPO_ROOT"

  preflight_theme_asset_syntax

  gcloud config set project "$PROJECT_ID" >/dev/null

  # Default the runtime SA so the script works even if .cloudrun.env predates the
  # dedicated-SA convention.
  RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:-printdock-run@${PROJECT_ID}.iam.gserviceaccount.com}"
  echo "Runtime service account: $RUNTIME_SERVICE_ACCOUNT"
  if [[ "$DEPLOY_USE_CACHE" == "1" ]]; then
    echo "Build mode: Cloud Build + Kaniko cache (Artifact Registry repo: $AR_REPO)."
    echo "            Set DEPLOY_USE_CACHE=0 to fall back to 'gcloud run deploy --source .'."
  else
    echo "Build mode: legacy 'gcloud run deploy --source .' (no Kaniko cache)."
  fi

  preflight_runtime_service_account "$RUNTIME_SERVICE_ACCOUNT"

  create_or_rotate_secret "$SECRET_API_KEY_NAME" "${SHOPIFY_API_KEY:-}"
  create_or_rotate_secret "$SECRET_API_SECRET_NAME" "${SHOPIFY_API_SECRET:-}"

  preflight_runtime_secret_access "$RUNTIME_SERVICE_ACCOUNT" \
    "$SECRET_API_KEY_NAME" "$SECRET_API_SECRET_NAME"
}

# ---------------------------------------------------------------------------
# Mode handlers
# ---------------------------------------------------------------------------

run_shopify_app_deploy() {
  cd "$REPO_ROOT"
  preflight_theme_asset_syntax
  if ! command -v shopify >/dev/null 2>&1; then
    echo "ERROR: shopify CLI not found in PATH. Install it and re-run." >&2
    exit 1
  fi
  echo ""
  echo "==> shopify app deploy (extensions + scopes + URLs in shopify.app.toml)"
  if [[ -n "${DEPLOY_ASSUME_YES:-}" ]]; then
    echo "    (DEPLOY_ASSUME_YES: --allow-updates --allow-deletes, no release prompt)"
    shopify app deploy --allow-updates --allow-deletes
  else
    shopify app deploy
  fi
}

# Backend deploy with auto Phase 1 skip when the service already exists.
do_backend_only() {
  prepare_cloudrun_env

  local existing_url
  if existing_url="$(resolve_existing_service_url)"; then
    export SHOPIFY_APP_URL="$existing_url"
    echo ""
    echo "==> Service already exists at $SHOPIFY_APP_URL"
    echo "    Skipping legacy Phase 1 placeholder deploy."
    echo "    Deploying directly with the known SHOPIFY_APP_URL."
    deploy_base 1

    # Re-read the URL — Cloud Run can promote it to a regional hostname.
    local post_url
    post_url="$(gcloud run services describe "$SERVICE_NAME" \
      --region "$SERVICE_REGION" --format='value(status.url)')"
    if [[ -z "$post_url" ]]; then
      echo "ERROR: Failed to re-resolve SHOPIFY_APP_URL after deploy." >&2
      exit 1
    fi
    if [[ "$post_url" != "$SHOPIFY_APP_URL" ]]; then
      echo ""
      echo "==> Cloud Run URL changed from"
      echo "      $SHOPIFY_APP_URL"
      echo "    to"
      echo "      $post_url"
      echo "    Re-deploying once with the new URL so the runtime env stays in sync."
      SHOPIFY_APP_URL="$post_url"
      deploy_base 1
    fi
    SHOPIFY_APP_URL="$post_url"
  else
    echo ""
    echo "==> Cloud Run service '$SERVICE_NAME' not found in region '$SERVICE_REGION'."
    echo "    Falling back to the original two-phase first-time deploy."
    do_first_time_internal
  fi

  print_post_deploy_summary
}

# The original two-phase flow — only needed on the very first deploy or after
# a service deletion. Kept as a separate path so users can force it via the
# 'first-time' menu entry.
do_first_time_internal() {
  echo "Phase 1/2: deploy without SHOPIFY_APP_URL"
  deploy_base 0

  export SHOPIFY_APP_URL
  SHOPIFY_APP_URL="$(gcloud run services describe "$SERVICE_NAME" \
    --region "$SERVICE_REGION" --format='value(status.url)')"
  if [[ -z "$SHOPIFY_APP_URL" ]]; then
    echo "ERROR: Failed to resolve SHOPIFY_APP_URL from Cloud Run service." >&2
    exit 1
  fi
  echo "Resolved SHOPIFY_APP_URL=$SHOPIFY_APP_URL"

  echo "Phase 2/2: deploy with SHOPIFY_APP_URL"
  deploy_base 1

  SHOPIFY_APP_URL="$(gcloud run services describe "$SERVICE_NAME" \
    --region "$SERVICE_REGION" --format='value(status.url)')"
  if [[ -z "$SHOPIFY_APP_URL" ]]; then
    echo "ERROR: Failed to re-resolve SHOPIFY_APP_URL after phase 2." >&2
    exit 1
  fi
}

do_first_time() {
  prepare_cloudrun_env
  do_first_time_internal
  print_post_deploy_summary
  # First-time always implies extensions need pushing too.
  run_shopify_app_deploy
}

do_extensions_only() {
  cd "$REPO_ROOT"
  run_shopify_app_deploy
}

do_full() {
  do_backend_only
  run_shopify_app_deploy
}

do_patch_toml_only() {
  require_cmd gcloud
  require_env PROJECT_ID
  require_env SERVICE_NAME
  require_env SERVICE_REGION

  gcloud config set project "$PROJECT_ID" >/dev/null

  local url
  if ! url="$(resolve_existing_service_url)"; then
    echo "ERROR: Cloud Run service '$SERVICE_NAME' not found in region '$SERVICE_REGION'." >&2
    echo "Run a 'first-time' deploy first, or check SERVICE_NAME / SERVICE_REGION." >&2
    exit 1
  fi
  echo "Cloud Run URL: $url"
  patch_shopify_app_toml "$url"
}

do_status() {
  require_cmd gcloud
  require_env PROJECT_ID
  require_env SERVICE_NAME
  require_env SERVICE_REGION

  gcloud config set project "$PROJECT_ID" >/dev/null
  echo "Project:   $PROJECT_ID"
  echo "Service:   $SERVICE_NAME"
  echo "Region:    $SERVICE_REGION"
  echo ""
  if ! gcloud run services describe "$SERVICE_NAME" \
    --region "$SERVICE_REGION" \
    --format="table(status.url, status.latestReadyRevisionName, status.latestCreatedRevisionName, metadata.annotations.'serving.knative.dev/lastModifier')"; then
    echo ""
    echo "Service does not exist yet. Run 'first-time' to create it."
    exit 1
  fi
}

print_post_deploy_summary() {
  echo ""
  echo "Final SHOPIFY_APP_URL=$SHOPIFY_APP_URL"
  cat <<EOF

Cloud Run deploy completed.

Next steps (only if URL changed since the last 'shopify app deploy'):
1) Update shopify.app.toml with:
   - application_url = "$SHOPIFY_APP_URL"
   - [auth] redirect_urls includes "$SHOPIFY_APP_URL/auth/callback"
   - [app_proxy] url = "$SHOPIFY_APP_URL"
2) Run: shopify app deploy
3) Reinstall app on target store if URL changed.
EOF

  echo ""
  if [[ -n "${DEPLOY_ASSUME_YES:-}" ]]; then
    echo "DEPLOY_ASSUME_YES: patching shopify.app.toml to $SHOPIFY_APP_URL"
    patch_shopify_app_toml "$SHOPIFY_APP_URL" || true
  elif is_interactive_shell; then
    if prompt_yes "Patch shopify.app.toml to the URL above?"; then
      patch_shopify_app_toml "$SHOPIFY_APP_URL" || true
    fi
  fi
}

# ---------------------------------------------------------------------------
# Mode resolution
# ---------------------------------------------------------------------------

# Look at uncommitted + recently committed changes to recommend the smallest
# sufficient mode. Echoes one of: ext, backend, full, "" (unknown).
detect_change_recommendation() {
  if ! command -v git >/dev/null 2>&1; then
    echo ""
    return
  fi
  if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo ""
    return
  fi

  local files
  files="$( {
    git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null
    git -C "$REPO_ROOT" diff --cached --name-only 2>/dev/null
    git -C "$REPO_ROOT" ls-files --others --exclude-standard 2>/dev/null
    git -C "$REPO_ROOT" diff --name-only HEAD~1 HEAD 2>/dev/null
  } | sort -u)"

  if [[ -z "$files" ]]; then
    echo ""
    return
  fi

  local has_backend=0 has_ext=0
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    case "$f" in
      app/*|Dockerfile|package.json|package-lock.json|.cloudrun.env|scripts/deploy-cloudrun-two-phase.sh)
        has_backend=1 ;;
      extensions/*|shopify.app.toml|shopify.web.toml)
        has_ext=1 ;;
    esac
  done <<< "$files"

  if (( has_backend && has_ext )); then
    echo "full"
  elif (( has_backend )); then
    echo "backend"
  elif (( has_ext )); then
    echo "ext"
  else
    echo ""
  fi
}

normalize_mode() {
  case "$1" in
    ext|extension|extensions) echo "ext" ;;
    backend|cloudrun|server) echo "backend" ;;
    full|both|all) echo "full" ;;
    first|first-time|init|bootstrap) echo "first-time" ;;
    patch|patch-toml|toml) echo "patch-toml" ;;
    status|info|describe) echo "status" ;;
    "") echo "" ;;
    *) echo "__invalid__" ;;
  esac
}

prompt_menu() {
  local recommended="$1"
  local default_choice="2"   # backend
  local rec_label=""

  case "$recommended" in
    ext)        default_choice="1"; rec_label="extensions only" ;;
    backend)    default_choice="2"; rec_label="backend only" ;;
    full)       default_choice="3"; rec_label="backend + extensions" ;;
  esac

  {
    echo ""
    echo "========================================"
    echo "  PrintDock Cloud Run Deploy"
    echo "========================================"
    if [[ -n "$rec_label" ]]; then
      echo "Recommended based on changed files: $rec_label"
    fi
    echo ""
    echo "  1) Extensions only      (~60-90s, just 'shopify app deploy')"
    echo "  2) Backend only         (~2-3 min with Kaniko cache; ~5 min cold cache)"
    echo "  3) Backend + extensions (full update of both)"
    echo "  4) First-time / clean   (force two-phase + extensions; re-create service)"
    echo "  5) Patch shopify.app.toml URLs to current Cloud Run URL"
    echo "  6) Show Cloud Run service status"
    echo "  q) Quit"
    if [[ "$DEPLOY_USE_CACHE" == "1" ]]; then
      echo ""
      echo "(Build cache: ON. Set DEPLOY_USE_CACHE=0 to fall back to --source .)"
    else
      echo ""
      echo "(Build cache: OFF. Unset DEPLOY_USE_CACHE to re-enable Kaniko cache.)"
    fi
    echo ""
  } >&2

  local reply
  read -r -p "Choice [1-6, q] (default $default_choice): " reply
  reply="${reply:-$default_choice}"

  case "$reply" in
    1) echo "ext" ;;
    2) echo "backend" ;;
    3) echo "full" ;;
    4) echo "first-time" ;;
    5) echo "patch-toml" ;;
    6) echo "status" ;;
    q|Q) echo "__quit__" ;;
    *) echo "__invalid__" ;;
  esac
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

if [[ -n "$MODE" ]]; then
  MODE="$(normalize_mode "$MODE")"
  if [[ "$MODE" == "__invalid__" || -z "$MODE" ]]; then
    echo "ERROR: Unknown --mode value." >&2
    usage >&2
    exit 1
  fi
else
  if is_interactive_shell; then
    RECOMMENDED="$(detect_change_recommendation)"
    MODE="$(prompt_menu "$RECOMMENDED")"
    if [[ "$MODE" == "__quit__" ]]; then
      echo "Aborted."
      exit 0
    fi
    if [[ "$MODE" == "__invalid__" || -z "$MODE" ]]; then
      echo "ERROR: Invalid menu choice." >&2
      exit 1
    fi
  else
    MODE="backend"
    echo "Non-interactive shell detected; defaulting to mode 'backend'."
  fi
fi

case "$MODE" in
  ext)        do_extensions_only ;;
  backend)    do_backend_only ;;
  full)       do_full ;;
  first-time) do_first_time ;;
  patch-toml) do_patch_toml_only ;;
  status)     do_status ;;
  *) echo "ERROR: Unknown resolved mode '$MODE'." >&2; exit 1 ;;
esac

echo ""
echo "Done (mode: $MODE)."
