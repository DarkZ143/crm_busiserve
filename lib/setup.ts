import "server-only";

import { adminDb } from "@/lib/firebase-admin";

export async function isSetupComplete() {
  const admins = await adminDb()
    .collection("users")
    .where("role", "==", "super_admin")
    .limit(1)
    .get();
  return !admins.empty;
}
