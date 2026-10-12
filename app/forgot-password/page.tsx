import type { Metadata } from "next";
import Link from "next/link";
import { AuthLayout } from "@/app/components/auth-layout";
import { ForgotPasswordForm } from "@/app/components/auth-forms";
import { hasAuthApiKey, isFirebaseConfigured } from "@/lib/firebase-admin";

export const metadata: Metadata = { title: "Recover account" };

export default function ForgotPasswordPage() {
  return (
    <AuthLayout
      eyebrow="Account recovery"
      title="Get back in."
      description="Enter your work email and we’ll send recovery instructions if an account matches."
    >
      <ForgotPasswordForm configured={isFirebaseConfigured() && hasAuthApiKey()} />
      <p className="form-helper" style={{ marginTop: 18 }}>
        Need help? <Link className="inline-link" href="/login">Return to sign in</Link>
      </p>
    </AuthLayout>
  );
}
