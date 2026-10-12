import type { Metadata } from "next";
import { AuthLayout } from "@/app/components/auth-layout";
import { LoginForm } from "@/app/components/auth-forms";
import { hasAuthApiKey, isFirebaseConfigured } from "@/lib/firebase-admin";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  const configured = isFirebaseConfigured() && hasAuthApiKey();
  return (
    <AuthLayout
      eyebrow="Private company workspace"
      title="Welcome back."
      description="Sign in to follow project delivery, team activity, and the work that moves your business forward."
    >
      <LoginForm configured={configured} />
    </AuthLayout>
  );
}
