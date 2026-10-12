import "server-only";

import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

function readServiceAccount() {
  const raw = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string | undefined>;
      const projectId = parsed.projectId ?? parsed.project_id;
      const clientEmail = parsed.clientEmail ?? parsed.client_email;
      const privateKey = parsed.privateKey ?? parsed.private_key;
      if (!projectId || !clientEmail || !privateKey) throw new Error("Missing service account fields.");
      return { projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, "\n") };
    } catch {
      throw new Error("FIREBASE_ADMIN_SERVICE_ACCOUNT must contain valid JSON.");
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey };
  }
  return null;
}

const serviceAccount = readServiceAccount();

export function isFirebaseConfigured() {
  return Boolean(serviceAccount || (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_USE_APPLICATION_DEFAULT === "true"));
}

export function hasAuthApiKey() {
  return Boolean(process.env.FIREBASE_API_KEY);
}

function app() {
  if (!isFirebaseConfigured() || !serviceAccount) {
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_USE_APPLICATION_DEFAULT === "true") {
      return getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
    }
    throw new Error("Firebase Admin is not configured.");
  }
  return getApps()[0] ?? initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.projectId || process.env.FIREBASE_PROJECT_ID,
  });
}

export function adminAuth() {
  return getAuth(app());
}

export function adminDb() {
  return getFirestore(app());
}
