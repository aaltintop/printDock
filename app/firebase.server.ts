import { initializeApp, getApps, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";

// Prevent multiple initializations in development
if (!getApps().length) {
  let credential;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    // Option 1: Parse JSON string from env var
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    credential = cert(serviceAccount);
  } else {
    // Option 2 & 3: Use GOOGLE_APPLICATION_CREDENTIALS file path or Cloud Run default
    credential = applicationDefault();
  }

  initializeApp({
    credential,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

export const db = getFirestore();
export const storage = getStorage();
export const auth = getAuth();
