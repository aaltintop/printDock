import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function resolveCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    return cert(serviceAccount);
  }
  return applicationDefault();
}

if (!getApps().length) {
  initializeApp({
    credential: resolveCredential(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

const db = getFirestore();
const dryRun = process.argv.includes("--dry-run");
const deleteLegacy = process.argv.includes("--delete-legacy");
const migrationAt = new Date().toISOString();

async function copyDoc({ sourceRef, targetRef, payload }) {
  if (dryRun) {
    console.log(`[dry-run] set ${targetRef.path}`);
    return;
  }

  await targetRef.set(payload, { merge: true });
  if (deleteLegacy) {
    await sourceRef.delete();
  }
}

async function migrateUploadFields() {
  const snapshot = await db.collection("uploadFields").get();
  let migrated = 0;

  for (const doc of snapshot.docs) {
    const source = doc.data();
    if (!source.shopDomain) continue;
    const target = db
      .collection("shops")
      .doc(source.shopDomain)
      .collection("fields")
      .doc(doc.id);

    await copyDoc({
      sourceRef: doc.ref,
      targetRef: target,
      payload: {
        ...source,
        migratedAt: migrationAt,
      },
    });
    migrated += 1;
  }

  console.log(`uploadFields migrated: ${migrated}`);
}

async function migrateSessions() {
  const snapshot = await db.collection("sessions").get();
  let migrated = 0;

  for (const doc of snapshot.docs) {
    const source = doc.data();
    if (!source.shopDomain) continue;

    const sessionRef = db
      .collection("shops")
      .doc(source.shopDomain)
      .collection("sessions")
      .doc(doc.id);

    const assets = Array.isArray(source.assets)
      ? source.assets
      : source.asset
        ? [{ ...source.asset, id: source.asset.id || "asset_legacy" }]
        : [];

    await copyDoc({
      sourceRef: doc.ref,
      targetRef: sessionRef,
      payload: {
        ...source,
        assets,
        asset: assets[0] || null,
        migratedAt: migrationAt,
      },
    });

    for (const asset of assets) {
      const assetId = String(asset.id || "asset_legacy");
      const assetRef = sessionRef.collection("assets").doc(assetId);
      if (dryRun) {
        console.log(`[dry-run] set ${assetRef.path}`);
      } else {
        await assetRef.set(asset, { merge: true });
      }
    }

    migrated += 1;
  }

  console.log(`sessions migrated: ${migrated}`);
}

async function migrateJobs() {
  const snapshot = await db.collection("jobs").get();
  let migrated = 0;

  for (const doc of snapshot.docs) {
    const source = doc.data();
    if (!source.shopDomain) continue;

    const target = db
      .collection("shops")
      .doc(source.shopDomain)
      .collection("jobs")
      .doc(doc.id);

    await copyDoc({
      sourceRef: doc.ref,
      targetRef: target,
      payload: {
        ...source,
        migratedAt: migrationAt,
      },
    });
    migrated += 1;
  }

  console.log(`jobs migrated: ${migrated}`);
}

async function migrateBillingPlans() {
  const snapshot = await db.collection("billingPlans").get();
  let migrated = 0;

  for (const doc of snapshot.docs) {
    const source = doc.data();
    const shopDomain = source.shopDomain || doc.id;
    if (!shopDomain) continue;

    const target = db
      .collection("shops")
      .doc(shopDomain)
      .collection("billing")
      .doc("plan");

    await copyDoc({
      sourceRef: doc.ref,
      targetRef: target,
      payload: {
        ...source,
        shopDomain,
        migratedAt: migrationAt,
      },
    });
    migrated += 1;
  }

  console.log(`billingPlans migrated: ${migrated}`);
}

async function migrateBillableLines() {
  const snapshot = await db.collection("billableLines").get();
  let migrated = 0;

  for (const doc of snapshot.docs) {
    const source = doc.data();
    if (!source.shopDomain) continue;

    const target = db
      .collection("shops")
      .doc(source.shopDomain)
      .collection("billableLines")
      .doc(doc.id);

    await copyDoc({
      sourceRef: doc.ref,
      targetRef: target,
      payload: {
        ...source,
        migratedAt: migrationAt,
      },
    });
    migrated += 1;
  }

  console.log(`billableLines migrated: ${migrated}`);
}

async function run() {
  console.log(`Starting Firestore hierarchy migration${dryRun ? " (dry-run)" : ""}`);
  await migrateUploadFields();
  await migrateSessions();
  await migrateJobs();
  await migrateBillingPlans();
  await migrateBillableLines();
  console.log("Migration completed.");
}

run().catch((error) => {
  console.error("Migration failed:", error);
  process.exitCode = 1;
});

