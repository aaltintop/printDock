import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const ALLOWED_DEV_SHOPS = [
  "printdock-test-store-1.myshopify.com",
  "levyapps.myshopify.com",
];

const VALID_PLAN_CODES = new Set(["free", "starter", "pro", "business"]);

function resolveCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    return cert(serviceAccount);
  }
  return applicationDefault();
}

function parseArgs(argv) {
  const args = { shop: null, plan: null, status: "active", clear: false, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--shop") {
      args.shop = argv[++i] ?? null;
    } else if (arg === "--plan") {
      args.plan = argv[++i] ?? null;
    } else if (arg === "--status") {
      args.status = argv[++i] ?? "active";
    } else if (arg === "--clear") {
      args.clear = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

function normalizeShopDomain(input) {
  const trimmed = String(input ?? "").trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed.endsWith(".myshopify.com")) return trimmed;
  return `${trimmed}.myshopify.com`;
}

function usage() {
  console.error(`Usage:
  node scripts/set-dev-billing-plan.mjs --shop <domain> --plan <free|starter|pro|business> [--status active|trial] [--dry-run]
  node scripts/set-dev-billing-plan.mjs --shop <domain> --clear [--dry-run]

Allowed dev shops: ${ALLOWED_DEV_SHOPS.join(", ")}`);
}

const args = parseArgs(process.argv);
if (!args.shop) {
  usage();
  process.exit(1);
}

const shopDomain = normalizeShopDomain(args.shop);
if (!ALLOWED_DEV_SHOPS.includes(shopDomain)) {
  console.error(
    `Refusing to write: "${shopDomain}" is not in ALLOWED_DEV_SHOPS.\n` +
      `Allowed: ${ALLOWED_DEV_SHOPS.join(", ")}\n` +
      `Add the domain to scripts/set-dev-billing-plan.mjs if this is intentional.`,
  );
  process.exit(1);
}

if (!args.clear) {
  if (!args.plan || !VALID_PLAN_CODES.has(args.plan)) {
    console.error("--plan is required and must be one of: free, starter, pro, business");
    usage();
    process.exit(1);
  }
}

if (!getApps().length) {
  initializeApp({
    credential: resolveCredential(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

const db = getFirestore();
const projectId =
  process.env.FIREBASE_PROJECT_ID ?? getApps()[0]?.options?.projectId ?? "(unknown)";
console.log(`Firebase projectId: ${projectId}`);
console.log(`Target shop: ${shopDomain}`);

const planRef = db.collection("shops").doc(shopDomain).collection("billing").doc("plan");
const updatedAt = new Date().toISOString();

if (args.clear) {
  const payload = {
    planCode: "free",
    status: "active",
    subscriptionId: null,
    source: FieldValue.delete(),
    updatedAt,
  };
  if (args.dryRun) {
    console.log("[dry-run] would clear dev override:", payload);
    process.exit(0);
  }
  await planRef.set(payload, { merge: true });
  console.log("Cleared dev billing override; shop is on free/active.");
  process.exit(0);
}

const payload = {
  planCode: args.plan,
  status: args.status,
  subscriptionId: null,
  source: "dev_override",
  updatedAt,
};

console.warn(
  "WARNING: Bypassing Shopify subscription flow. Use $0 private test plans to test billing itself.",
);

if (args.dryRun) {
  console.log("[dry-run] would write:", payload);
  process.exit(0);
}

await planRef.set(payload, { merge: true });
console.log(`Set billing plan: planCode=${args.plan}, status=${args.status}, source=dev_override`);
