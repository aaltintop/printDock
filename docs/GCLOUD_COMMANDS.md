# PrintDock GCloud Commands Reference

This document lists the `gcloud` commands used for PrintDock deployment and operations on Google Cloud Run.

Use these commands from your local terminal in the project root unless noted.

---

## 1) Install, Auth, and Identity

```bash
# Verify CLI
gcloud version

# Login to Google account
gcloud auth login

# Login for Application Default Credentials (ADC)
gcloud auth application-default login

# Show authenticated accounts (active account has *)
gcloud auth list

# Show active account + active project
gcloud config list --format="text(core.account,core.project)"
```

Switch account:

```bash
gcloud config set account your-email@example.com
```

---

## 2) Project Setup

```bash
# Optional: create a new project (skip if Firebase project already exists)
gcloud projects create YOUR_PROJECT_ID

# Set active project
gcloud config set project YOUR_PROJECT_ID

# Verify project details
gcloud projects describe YOUR_PROJECT_ID --format="value(projectNumber,name,projectId)"
```

---

## 3) Enable Required APIs

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com
```

---

## 4) IAM Role Grants (Operator and Runtime)

Grant roles to your user for deployment tasks:

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export USER_EMAIL="your-email@example.com"

for role in "roles/run.developer" "roles/secretmanager.admin" "roles/iam.serviceAccountUser" "roles/cloudbuild.builds.editor"; do
  gcloud projects add-iam-policy-binding $PROJECT_ID --member="user:$USER_EMAIL" --role="$role"
done
```

Grant Secret Manager accessor role to default compute service account:

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

Grant Firestore + Storage to Cloud Run runtime service account:

```bash
export SERVICE_NAME="printdock-service"
export SERVICE_REGION="europe-west1"

SERVICE_ACCOUNT=$(gcloud run services describe $SERVICE_NAME --region=$SERVICE_REGION --format="value(spec.template.spec.serviceAccountName)")

gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:${SERVICE_ACCOUNT}" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:${SERVICE_ACCOUNT}" --role="roles/storage.objectAdmin"
```

---

## 5) Secret Manager

Create secrets (first time):

```bash
echo "$SHOPIFY_API_KEY" | gcloud secrets create shopify-api-key --data-file=-
echo "$SHOPIFY_API_SECRET" | gcloud secrets create shopify-api-secret --data-file=-
```

List secrets:

```bash
gcloud secrets list
```

Rotate existing secret value:

```bash
echo "NEW_VALUE" | gcloud secrets versions add shopify-api-secret --data-file=-
```

Describe secret metadata:

```bash
gcloud secrets describe shopify-api-secret
```

---

## 6) Cloud Run Deployments

Quick setup script (recommended):

```bash
# Source (do not run) so exports persist in your current shell
source scripts/setup-cloudrun-env.sh

# Optional: non-interactive mode uses defaults from .env/current env
source scripts/setup-cloudrun-env.sh --non-interactive
```

Interactive script behavior:
- Shows a short guide before prompts
- Press Enter to accept defaults
- Type `q`, `quit`, or `exit` at any prompt to cancel

The script exports:
- `PROJECT_ID`
- `SERVICE_NAME`
- `SERVICE_REGION`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`

It also writes reusable exports to `.cloudrun.env` for future sessions:

```bash
source .cloudrun.env
```

Two-phase Cloud Run deploy script:

```bash
# Ensure vars are loaded first
source scripts/setup-cloudrun-env.sh

# Ensure SCOPES + Shopify credentials are available in current shell
eval $(shopify app info --web-env)

# Run two-phase deploy (first deploy to get URL, second with SHOPIFY_APP_URL)
./scripts/deploy-cloudrun-two-phase.sh
```

Notes:
- Uses Secret Manager secrets: `shopify-api-key`, `shopify-api-secret`
- If secrets already exist, it keeps latest values unless `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` are set in shell, in which case it rotates by adding new secret versions.
- After script completes, update `shopify.app.toml` URLs and run `shopify app deploy`.

Set deployment variables:

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export SERVICE_NAME="printdock-service"
export SERVICE_REGION="europe-west1"
export FIREBASE_PROJECT_ID="YOUR_FIREBASE_PROJECT_ID"
export FIREBASE_STORAGE_BUCKET="YOUR_FIREBASE_BUCKET"
```

First deploy (obtain service URL):

```bash
gcloud run deploy $SERVICE_NAME \
  --source . \
  --region $SERVICE_REGION \
  --set-secrets="SHOPIFY_API_KEY=shopify-api-key:latest,SHOPIFY_API_SECRET=shopify-api-secret:latest" \
  --set-env-vars="SCOPES=$SCOPES,NODE_ENV=production,FIREBASE_PROJECT_ID=$FIREBASE_PROJECT_ID,FIREBASE_STORAGE_BUCKET=$FIREBASE_STORAGE_BUCKET" \
  --port 8080 \
  --min-instances 1 \
  --allow-unauthenticated
```

Read service URL:

```bash
export SHOPIFY_APP_URL=$(gcloud run services describe $SERVICE_NAME --region $SERVICE_REGION --format='value(status.url)')
echo $SHOPIFY_APP_URL
```

Second deploy (with `SHOPIFY_APP_URL`):

```bash
gcloud run deploy $SERVICE_NAME \
  --source . \
  --region $SERVICE_REGION \
  --set-secrets="SHOPIFY_API_KEY=shopify-api-key:latest,SHOPIFY_API_SECRET=shopify-api-secret:latest" \
  --set-env-vars="SCOPES=$SCOPES,SHOPIFY_APP_URL=$SHOPIFY_APP_URL,NODE_ENV=production,FIREBASE_PROJECT_ID=$FIREBASE_PROJECT_ID,FIREBASE_STORAGE_BUCKET=$FIREBASE_STORAGE_BUCKET" \
  --port 8080 \
  --min-instances 1 \
  --allow-unauthenticated
```

Subsequent code deploy:

```bash
gcloud run deploy $SERVICE_NAME --source . --region $SERVICE_REGION --allow-unauthenticated
```

Force service refresh (for latest secret versions):

```bash
gcloud run services update $SERVICE_NAME --region $SERVICE_REGION
```

---

## 7) Cloud Run Inspection and Logs

List services:

```bash
gcloud run services list --region $SERVICE_REGION
```

Describe service:

```bash
gcloud run services describe $SERVICE_NAME --region $SERVICE_REGION
```

Read recent logs:

```bash
gcloud run services logs read $SERVICE_NAME --region $SERVICE_REGION --limit 50
```

Tail logs continuously:

```bash
gcloud beta run services logs tail $SERVICE_NAME --region $SERVICE_REGION
```

---

## 8) Revisions and Rollback

List revisions:

```bash
gcloud run revisions list --service $SERVICE_NAME --region $SERVICE_REGION
```

Route traffic to a specific revision (rollback):

```bash
gcloud run services update-traffic $SERVICE_NAME --region $SERVICE_REGION --to-revisions REVISION_NAME=100
```

---

## 9) Troubleshooting Checks

Quick sanity checks:

```bash
# Account + project
gcloud config list --format="text(core.account,core.project)"

# Service URL
gcloud run services describe $SERVICE_NAME --region $SERVICE_REGION --format='value(status.url)'

# Runtime service account
gcloud run services describe $SERVICE_NAME --region $SERVICE_REGION --format='value(spec.template.spec.serviceAccountName)'
```

---

## Notes

- `gcloud run deploy` hosts code on Cloud Run.
- `shopify app deploy` updates Shopify app configuration (URLs, webhooks, app proxy).
- For the full deployment walkthrough, see `docs/DEPLOY_CLOUD_RUN.md`.
