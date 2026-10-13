import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { isFirebaseConfigured } from "@/lib/firebase-admin";
import { isSetupComplete } from "@/lib/setup";
import type { Role } from "@/lib/types";

const homeByRole: Record<Role, string> = {
  super_admin: "/admin/dashboard",
  cto: "/cto/projects",
  product_manager: "/product-manager/projects",
  team_member: "/workspace/projects",
};

export default function HomePage() {
  return (
    <Suspense fallback={<div className="page-loading">Opening your workspace…</div>}>
      <HomeRedirect />
    </Suspense>
  );
}

async function HomeRedirect(): Promise<never> {
  await connection();
  if (!isFirebaseConfigured()) redirect("/setup");
  let setupComplete: boolean;
  try {
    setupComplete = await isSetupComplete();
  } catch (error) {
    console.error("Unable to read Firebase setup status", error instanceof Error ? error.name : "Unknown error");
    redirect("/setup?connection=error");
  }
  if (!setupComplete) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  redirect(homeByRole[user.role]);
}
