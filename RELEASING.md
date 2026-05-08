# Releasing PrintDock

This is the operational checklist for shipping a new PrintDock version. Branching strategy and naming rules live in [`GIT_FLOW.md`](./GIT_FLOW.md); this file is the *step-by-step* runbook.

## TL;DR

- **Minor / major release:** `dev` → `release/vX.Y.Z` → `main` → tag → deploy → back-merge into `dev`.
- **Hotfix:** previous tag → `hotfix/vX.Y.Z` → `main` → tag → deploy → back-merge into `dev`.
- **Tag is pushed before deploy.** Production image must equal the tag exactly.
- **One CHANGELOG entry per tag.** No exceptions.

---

## Versioning rules (semver)

| Bump        | When                                                                                        |
|-------------|---------------------------------------------------------------------------------------------|
| **MAJOR**   | Breaking change to merchant-visible behavior: pricing model, scopes, theme block API, data shape. |
| **MINOR**   | New feature, new plan tier, new extension, new webhook handler, new admin surface.          |
| **PATCH**   | Bug fix, copy change, dependency bump, internal refactor with no behavior change.           |

The git tag (`vX.Y.Z`) must match:

- The version submitted to the Shopify App Store.
- The `version` field in `package.json` (add it if missing).
- The version line in extension `shopify.extension.toml` files where applicable.

---

## Pre-flight checklist (before cutting any release branch)

Run from `dev` after pulling latest:

```bash
git checkout dev && git pull --ff-only

npm install
npm run typecheck
npm run lint
npm run build
```

Then verify:

- [ ] All open feature PRs targeting `dev` are either merged or deferred.
- [ ] Local `dev` matches `origin/dev` exactly (`git status` clean, no unpushed commits).
- [ ] Staging Cloud Run service (if used) is healthy and matches `dev` HEAD.
- [ ] Manual smoke test on staging: install → onboarding → upload → cart transform → checkout → privacy webhooks.
- [ ] No secrets, `BOOTSTRAP_INPUTS.local.md`, or `.env*` files are tracked.

---

## Release flow (minor / major)

Replace `1.1.0` with the actual target version throughout.

### 1. Cut the release branch from `dev`

```bash
git checkout dev && git pull --ff-only
git checkout -b release/v1.1.0
```

### 2. Release prep commits

On `release/v1.1.0` only:

- [ ] Bump `version` in `package.json` to `1.1.0`.
- [ ] Bump version in extension `shopify.extension.toml` files if changed.
- [ ] Move `## [Unreleased]` content in `CHANGELOG.md` into a new `## [1.1.0] — YYYY-MM-DD` section. Reset `[Unreleased]` to empty subsections.
- [ ] Update the `[Unreleased]` and `[1.1.0]` compare links at the bottom of `CHANGELOG.md`.
- [ ] If any merchant-facing copy changed, update the App Store listing draft (description, screenshots, demo video).

```bash
git add package.json CHANGELOG.md extensions/*/shopify.extension.toml
git commit -m "Prepare v1.1.0 release"
git push -u origin release/v1.1.0
```

### 3. Final verification on the release branch

- [ ] `npm run typecheck && npm run lint && npm run build` clean.
- [ ] Deploy `release/v1.1.0` to staging and re-run the smoke test.
- [ ] Confirm `shopify app deploy --version=1.1.0` produces the expected extension version.

### 4. Merge into `main`, tag, push

```bash
git checkout main && git pull --ff-only
git merge --no-ff release/v1.1.0 -m "Release v1.1.0"
git tag -a v1.1.0 -m "v1.1.0 — <one-line summary>"
git push origin main
git push origin v1.1.0
```

### 5. Deploy production

```bash
./scripts/deploy-cloudrun-two-phase.sh
shopify app deploy
```

- [ ] Cloud Run new revision is serving 100% traffic.
- [ ] `shopify app deploy` released the extension version successfully.
- [ ] App Store version submission updated (if this is a customer-visible release).

### 6. Back-merge into `dev`

So `dev` has the version bump, changelog header, and the merge commit on its history:

```bash
git checkout dev && git pull --ff-only
git merge --no-ff main -m "Back-merge v1.1.0 into dev"
git push origin dev
```

### 7. Clean up

```bash
git branch -d release/v1.1.0
git push origin --delete release/v1.1.0
```

The tag (`v1.1.0`) is the permanent record. The release branch is disposable.

---

## Hotfix flow

Use this when production has a bug and you cannot wait for the next planned release. Replace `1.0.1` with the actual target.

### 1. Branch from the last released tag, not from `main`

`main` may already contain unreleased merges. Branch from the tag to keep the hotfix scope minimal:

```bash
git fetch --tags
git checkout -b hotfix/v1.0.1 v1.0.0
```

### 2. Fix the bug + release prep on the hotfix branch

- [ ] Smallest possible change that resolves the bug.
- [ ] Bump `version` in `package.json` to `1.0.1`.
- [ ] Add a `## [1.0.1] — YYYY-MM-DD` section in `CHANGELOG.md` under **Fixed**.
- [ ] Update compare links.

```bash
git add -A
git commit -m "Fix <short bug description>"
git commit -am "Prepare v1.0.1 release"
git push -u origin hotfix/v1.0.1
```

### 3. Verify on staging

- [ ] Deploy the hotfix branch to staging.
- [ ] Reproduce the original bug pre-fix, confirm it's gone post-fix.
- [ ] Re-run upload + checkout smoke test (the hotfix shouldn't break unrelated paths).

### 4. Merge into `main`, tag, deploy

```bash
git checkout main && git pull --ff-only
git merge --no-ff hotfix/v1.0.1 -m "Release v1.0.1"
git tag -a v1.0.1 -m "v1.0.1 — <fix summary>"
git push origin main
git push origin v1.0.1

./scripts/deploy-cloudrun-two-phase.sh
shopify app deploy
```

### 5. Back-merge into `dev`

Critical so the fix isn't lost in the next minor release:

```bash
git checkout dev && git pull --ff-only
git merge --no-ff main -m "Back-merge v1.0.1 into dev"
git push origin dev
```

If the back-merge produces conflicts (because `dev` has already changed the same code), resolve in favor of keeping both: the hotfix's intent **and** the in-flight `dev` work. Add a regression test for the hotfix scenario before pushing.

### 6. Clean up

```bash
git branch -d hotfix/v1.0.1
git push origin --delete hotfix/v1.0.1
```

---

## Rollback

If a release is broken in production and a hotfix is not viable in the next 30 minutes:

1. **Cloud Run:** roll back to the previous revision.
   ```bash
   gcloud run services update-traffic <service> --to-revisions=<prev-revision>=100 --region=<region>
   ```
2. **Shopify extensions:** in the Partner Dashboard, set the previous extension version as active.
3. **Tag:** do **not** delete the broken tag. It's a historical record. Cut a new patch tag (`vX.Y.Z+1`) once you have a real fix.
4. Open a `## [Unreleased]` entry under **Fixed** describing what happened, so the next CHANGELOG section captures the incident.

---

## After every release

- [ ] Confirm `main`, the `vX.Y.Z` tag, the deployed Cloud Run revision, and the published Shopify extension version all agree.
- [ ] Close any tracking issues / Linear tickets associated with the release.
- [ ] Update `SHOPIFY_APP_BLUEPRINT.md` if any reusable lesson came out of the release (especially in section 16, "Pitfalls & Lessons from PrintDock").

---

## Common mistakes to avoid

- **Tagging after deploy.** The tag must be pushed first. If you deploy then tag, you've already lost the guarantee that the tag matches what's running.
- **Forgetting the back-merge.** Without it, `dev` doesn't have the new version bump or hotfix, and the next release will silently regress the fix.
- **Editing `main` directly.** All commits on `main` should arrive via release/hotfix merges. If you find yourself committing on `main`, stop — branch off and merge.
- **Squashing the release merge.** Use `--no-ff` so `git log main --first-parent` reads as a clean release history.
- **Reusing a release branch.** Each version gets its own `release/vX.Y.Z` branch, deleted after merge.
