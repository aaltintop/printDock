# PrintDock — Google Cloud Run Deployment Guide

This document contains all steps required to deploy the PrintDock Shopify app
to Google Cloud Run.

**Stack:** React Router 7 + `@shopify/shopify-app-react-router`, Firestore,
Firebase Storage, Cloud Run.
There is no Prisma or PostgreSQL — skip any guide sections that reference those.

---

## Prerequisites

- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- Shopify CLI installed (`npm install -g @shopify/cli`)
- Node.js 20+
- A Google Cloud / Firebase project already created (Firestore + Storage activated)
- The PrintDock repo cloned locally

> **Same GCP project = simplest path.**
> Every Firebase project is a GCP project under the hood. If you deploy Cloud Run
> to the **exact same Project ID** as your Firebase project, Application Default
> Credentials (ADC) work automatically — no service account JSON key needed.
> This guide assumes the same project. If they differ, see the note in Step 6.

---

## Key concepts before you start

**`gcloud run deploy`** — hosts your Node.js code. Builds a Docker container,
runs it on Google's servers, gives you an HTTPS URL.

**`shopify app deploy`** — updates Shopify's registry. Reads `shopify.app.toml`
and tells Shopify where to send OAuth redirects, webhooks, and App Proxy
requests. Does not host any code.

**Always run them in this order:**
1. `gcloud run deploy` → get the Cloud Run URL
2. Update `shopify.app.toml` with that URL
3. `shopify app deploy` → Shopify now knows where your app lives

---

## Environment Variables Reference

| Variable | Source |
|---|---|
| `SHOPIFY_API_KEY` | Shopify Partners → App → API credentials |
| `SHOPIFY_API_SECRET` | Shopify Partners → App → API credentials |
| `SCOPES` | Must match `shopify.app.toml` (comma-separated) |
| `SHOPIFY_APP_URL` | Cloud Run service URL (obtained after first deploy) |
| `FIREBASE_PROJECT_ID` | Firebase Console → Project settings |
| `FIREBASE_STORAGE_BUCKET` | Firebase Console → Storage bucket name |
| `NODE_ENV` | Set to `production` |
| `LOG_LEVEL` | `info` in production (set by deploy script). Use `debug` locally in `.env` for verbose JSON logs. |

`FIREBASE_SERVICE_ACCOUNT_JSON` is **not required** when Cloud Run and Firebase
share the same GCP project. ADC handles authentication automatically.

### Required IAM: v4 signed uploads

Firebase Storage presigned (v4) upload URLs are generated from Cloud Run using
ADC. Because ADC has no private key, `@google-cloud/storage` signs via IAM's
`signBlob` API. The Cloud Run runtime service account must therefore be able to
sign tokens for itself, or upload session requests fail with:

```
SigningError: Permission 'iam.serviceAccounts.signBlob' denied on resource (or it may not exist).
```

Grant the role once per project (substitute the project number):

```bash
RUNTIME_SA="$(gcloud run services describe printdock-service \
  --region us-central1 \
  --format='value(spec.template.spec.serviceAccountName)')"

gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/iam.serviceAccountTokenCreator"
```

If Cloud Run runs as the default Compute SA (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`),
use that as both the target and the member.

---

## Step 1 — Gather Shopify App Configuration

Run from the root of the PrintDock project directory.

```bash
# Export SHOPIFY_API_KEY, SHOPIFY_API_SECRET, and SCOPES into the shell session
eval $(shopify app info --web-env)

# Link shopify.app.toml config (skip if already done)
shopify app config link
```

Verify the variables are set:

```bash
echo $SHOPIFY_API_KEY
echo $SHOPIFY_API_SECRET
echo $SCOPES
```

---

## Step 2 — Create and Connect a GCP Project

```bash
# Define identifiers — customize as needed
export PROJECT_ID="printdock-app"
export SERVICE_NAME="printdock-service"

# Create the GCP project
# SKIP this if you are deploying into your existing Firebase GCP project
gcloud projects create $PROJECT_ID

# Set this project as active for all subsequent commands
gcloud config set project $PROJECT_ID
```

> If your Firebase project already exists, run only `gcloud config set project YOUR_FIREBASE_PROJECT_ID`
> and skip `gcloud projects create`.

---

## Step 3 — Enable Required APIs and Grant Permissions

```bash
# Enable Cloud Run, Cloud Build, Secret Manager, and Artifact Registry
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com

# Set your Google Cloud account email
export USER_EMAIL="your-email@example.com"

# Grant yourself the necessary IAM roles
for role in "roles/run.developer" "roles/secretmanager.admin" \
  "roles/iam.serviceAccountUser" "roles/cloudbuild.builds.editor"; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="user:$USER_EMAIL" --role="$role"
done
```

---

## Step 4 — Store Secrets in Secret Manager

```bash
# Store Shopify credentials as secrets (first time only)
echo $SHOPIFY_API_KEY    | gcloud secrets create shopify-api-key    --data-file=-
echo $SHOPIFY_API_SECRET | gcloud secrets create shopify-api-secret --data-file=-

# Verify secrets were created
gcloud secrets list

# Get the project number to build the default service account email
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")

# Grant the Compute Engine default service account access to the secrets
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### Rotating a secret later

`gcloud secrets create` fails if the secret already exists.
To update an existing secret value (e.g. after regenerating the Shopify API secret):

```bash
echo NEW_VALUE | gcloud secrets versions add shopify-api-secret --data-file=-
```

After adding a new version, force Cloud Run to pick it up by redeploying:

```bash
gcloud run services update $SERVICE_NAME --region $SERVICE_REGION
```

Cloud Run reads secrets at boot time. Existing running instances keep the old
value until they restart.

---

## Step 5 — Automated Deployment

We have created a two-phase deployment script that handles the Cloud Run deployment automatically.

### Why a two-phase deploy?
1. **Phase 1:** Deploys the code to Cloud Run with a placeholder `SHOPIFY_APP_URL`. This creates the service and generates the real HTTPS URL.
2. **Phase 2:** Re-deploys the code using the real `SHOPIFY_APP_URL` so the Shopify app package boots correctly.

### Run the deployment script

```bash
# 1. Set up your environment variables (interactive prompt)
source scripts/setup-cloudrun-env.sh

# 2. Load Shopify credentials into your shell
eval $(shopify app info --web-env)

# 3. Run the deployment script
./scripts/deploy-cloudrun-two-phase.sh
```

> **Note:** The script will automatically create or rotate the `shopify-api-key` and `shopify-api-secret` in Google Secret Manager.

### Post-deploy prompts (interactive only)

After Cloud Run finishes, the script prints **Final SHOPIFY_APP_URL** and the usual manual next steps. If **stdin and stdout are both TTYs** (a normal terminal session) and **`DEPLOY_NON_INTERACTIVE` is not set**, it then asks:

1. Whether to **patch `shopify.app.toml`** so `application_url`, `[auth].redirect_urls`, and `[app_proxy].url` match that final URL (in-place edit via `perl`).
2. Whether to run **`shopify app deploy`** from the repo root.

Reply with **`y` or `yes`** to run; anything else (including Enter) skips.

| Situation | Behavior |
|-----------|----------|
| Local terminal | Prompts appear after deploy |
| `DEPLOY_NON_INTERACTIVE=1` | Prompts skipped; do Step 7 manually |
| CI / piped stdin (non-TTY) | Prompts skipped |

If **`perl`** is missing, decline the TOML prompt and edit `shopify.app.toml` by hand (Step 7a). If **`shopify`** is not on `PATH`, decline the deploy prompt and run `shopify app deploy` yourself (Step 7b).

---

## Step 6 — Grant Cloud Run Access to Firebase

> **Do NOT set up Cloud SQL or Prisma.** PrintDock uses Firestore, which is
> already hosted in GCP. This replaces Step 6 from the official Shopify guide.

Get the service account identity used by the Cloud Run service:

```bash
SERVICE_ACCOUNT=$(gcloud run services describe $SERVICE_NAME \
  --region=$SERVICE_REGION \
  --format="value(spec.template.spec.serviceAccountName)")

echo $SERVICE_ACCOUNT
```

Grant Firestore and Storage permissions:

```bash
# Firestore read/write
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/datastore.user"

# Firebase Storage read/write
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/storage.objectAdmin"
```

> **If Firebase is in a different GCP project:** run the same two commands above
> but replace `$PROJECT_ID` with your Firebase project ID, and add
> `--project=YOUR_FIREBASE_PROJECT_ID` to each command. You will also need to
> store a service account JSON key as a secret and pass it via
> `FIREBASE_SERVICE_ACCOUNT_JSON`.

---

## Step 7 — Connect the Deployed App to Shopify

### 7a — Update `shopify.app.toml`

Open `shopify.app.toml` and replace all references to `example.com` (or your old tunnel URL) with the new Cloud Run service URL output by the script — **or** accept the deploy script’s interactive offer to patch these fields automatically (see [Post-deploy prompts](#post-deploy-prompts-interactive-only)).

```toml
application_url = "https://printdock-service-xxxx-uc.a.run.app"

[auth]
redirect_urls = [ "https://printdock-service-xxxx-uc.a.run.app/api/auth" ]

[app_proxy]
url = "https://printdock-service-xxxx-uc.a.run.app"
```

> **`/api/auth` not `/auth/callback`.** This repo uses `/api/auth` as the OAuth
> redirect path. Using the wrong path here will break app installation.

### 7b — Deploy App Configuration to Shopify

```bash
shopify app deploy
```

This pushes the updated URLs, webhooks, and extension configuration to Shopify.

### 7c — Reinstall the App on Your Development Store

Because the app URL changed, the existing install token is invalid.

1. Go to your Shopify development store admin.
2. Uninstall the app.
3. Reinstall via the Shopify Partners dashboard.

---

## Step 8 — Verify Everything is Working

### Check Cloud Run logs

```bash
gcloud run services logs read $SERVICE_NAME --region $SERVICE_REGION --limit 50
```

### Verify Firestore session storage

After completing OAuth on your development store:

1. Go to Firebase Console → Firestore.
2. Look for a **top-level collection called `shopify_sessions`**.
3. Confirm a document exists with a key like `offline_yourstore.myshopify.com`.

> Sessions are stored in a flat top-level `shopify_sessions` collection — not
> under `shops/{domain}/sessions/`. This is intentional: the Shopify session
> storage interface provides only a session ID for lookups, so a top-level
> collection allows O(1) direct document reads without parsing the ID.

### Verify Storage

1. Go to Firebase Console → Storage
2. Confirm the bucket is accessible with no permission errors in Cloud Run logs

---

## Ongoing Deployments

Every time you push a code change to production, you only need to run the standard `gcloud run deploy` command. You do not need to run the two-phase script again unless your `SHOPIFY_APP_URL` changes.

```bash
source .cloudrun.env

gcloud run deploy $SERVICE_NAME \
  --source . \
  --region $SERVICE_REGION \
  --allow-unauthenticated
```

Secrets and environment variables persist from the previous deploy.

---

## What to Skip from the Official Shopify Guide

The official guide at `https://shopify.dev/docs/apps/launch/deployment/deploy-to-google-cloud-run`
includes a **Step 6: Set up a production database** section covering:

- Cloud SQL PostgreSQL instance
- Prisma production schema
- Cloud SQL Auth Proxy
- `prisma db push`

**Skip all of this.** PrintDock uses Firestore (fully managed, no setup required).
Do not create any Cloud SQL instance or touch any Prisma files.