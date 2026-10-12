import "server-only";

import { createHash } from "node:crypto";
import { adminDb } from "@/lib/firebase-admin";

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function requestIdentity(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = request.headers.get("x-real-ip") ?? forwarded ?? "unknown";
  return digest(ip).slice(0, 32);
}

export async function consumeRateLimit(key: string, limit: number, windowMs: number) {
  const db = adminDb();
  const ref = db.collection("rateLimits").doc(digest(key));
  const now = Date.now();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data();
    const resetAt = Number(data?.resetAt ?? 0);
    const count = resetAt > now ? Number(data?.count ?? 0) + 1 : 1;
    const nextReset = resetAt > now ? resetAt : now + windowMs;
    transaction.set(ref, { count, resetAt: nextReset, updatedAt: new Date(now) });
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt: nextReset };
  });
}

