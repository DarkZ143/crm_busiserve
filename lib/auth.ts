import "server-only";

import { cookies } from "next/headers";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import type { Role, SessionUser } from "@/lib/types";
import { ROLES } from "@/lib/types";

export const SESSION_COOKIE = "busiserve_session";
export const SESSION_LIFETIME_MS = 5 * 24 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
    this.name = "AuthError";
  }
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const decoded = await adminAuth().verifySessionCookie(token, true);
    const userRef = adminDb().collection("users").doc(decoded.uid);
    const [userSnapshot, authUser] = await Promise.all([
      userRef.get(),
      adminAuth().getUser(decoded.uid),
    ]);
    if (!userSnapshot.exists || authUser.disabled) return null;

    const user = userSnapshot.data();
    if (!user || user.accountStatus !== "active" || !ROLES.includes(user.role as Role)) {
      return null;
    }

    return {
      uid: decoded.uid,
      displayName: String(user.displayName ?? authUser.displayName ?? "Team member"),
      email: String(user.email ?? authUser.email ?? ""),
      role: user.role as Role,
      accountStatus: "active",
      ...(user.designation ? { designation: String(user.designation) } : {}),
    };
  } catch {
    return null;
  }
}

export async function requireSessionUser() {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Your session has expired. Please sign in.");
  return user;
}

export async function requireRole(...roles: Role[]) {
  const user = await requireSessionUser();
  if (!roles.includes(user.role)) throw new AuthError("You do not have access to this action.", 403);
  return user;
}
