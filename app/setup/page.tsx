import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { AuthLayout } from "@/app/components/auth-layout";
import { hasAuthApiKey, isFirebaseConfigured } from "@/lib/firebase-admin";
import { isSetupComplete } from "@/lib/setup";

export const metadata: Metadata = { title: "Firebase workspace setup" };

export default function SetupPage() {
  return (
    <Suspense fallback={<div className="page-loading">Checking workspace setup...</div>}>
      <SetupPageState />
    </Suspense>
  );
}

async function SetupPageState() {
  await connection();

  if (!isFirebaseConfigured() || !hasAuthApiKey()) {
    return (
      <AuthLayout eyebrow="Firebase setup" title="Connect your Firebase project." description="Add the server credentials before using this workspace.">
        <div className="notice notice-warning">Firebase is not fully configured for this environment.</div>
        <div className="setup-instructions">
          <strong>Required Firebase environment</strong>
          <code>FIREBASE_API_KEY</code>
          <code>FIREBASE_ADMIN_SERVICE_ACCOUNT</code>
          <code>or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY</code>
        </div>
      </AuthLayout>
    );
  }

  let setupComplete: boolean;
  try {
    setupComplete = await isSetupComplete();
  } catch {
    return (
      <AuthLayout eyebrow="Firebase setup" title="Check Firebase access." description="The server could not read the workspace user records.">
        <div className="notice notice-warning">Confirm the Firebase Admin credentials and Firestore access, then reload this page.</div>
      </AuthLayout>
    );
  }

  if (setupComplete) {
    return (
      <AuthLayout eyebrow="Workspace ready" title="Your Super Admin is configured." description="Sign in with that user's Firebase Authentication email and password.">
        <Link className="button button-primary button-wide" href="/login">Go to sign in</Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout eyebrow="Manual initial setup" title="Assign the first Super Admin in Firebase." description="Create the sign-in account, then give its Firestore user record the Super Admin role.">
      <div className="setup-instructions">
        <strong>1. Create the sign-in account</strong>
        <code>Firebase Console → Authentication → Users → Add user</code>
        <strong>2. Create its Firestore profile</strong>
        <code>Collection: users</code>
        <code>Document ID: the exact Authentication UID</code>
        <code>uid: same UID (string)</code>
        <code>displayName: user's name (string)</code>
        <code>email: same Authentication email (string)</code>
        <code>role: super_admin (string)</code>
        <code>accountStatus: active (string)</code>
      </div>
      <p className="form-helper">Save the document, then sign in using the email and password created in Authentication.</p>
      <Link className="button button-primary button-wide" href="/login">Go to sign in</Link>
    </AuthLayout>
  );
}
