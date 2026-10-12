import { NextResponse } from "next/server";
import { z } from "zod";
import { adminAuth, adminDb, hasAuthApiKey } from "@/lib/firebase-admin";
import { SESSION_COOKIE, SESSION_LIFETIME_MS } from "@/lib/auth";
import { assertSameOrigin, errorResponse } from "@/lib/http";
import { consumeRateLimit, requestIdentity } from "@/lib/security";

const signInSchema = z.object({
  email: z.email().max(254).transform((email) => email.trim().toLowerCase()),
  password: z.string().min(1).max(128),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (!hasAuthApiKey()) {
      return NextResponse.json({ error: "Firebase Authentication is not configured." }, { status: 503 });
    }
    const body = signInSchema.parse(await request.json());
    const limit = await consumeRateLimit(`login:${requestIdentity(request)}:${body.email}`, 8, 15 * 60 * 1000);
    if (!limit.allowed) return NextResponse.json({ error: "Too many attempts. Wait and try again." }, { status: 429 });

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(process.env.FIREBASE_API_KEY!)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: body.email, password: body.password, returnSecureToken: true }),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return NextResponse.json({ error: "Email or password is incorrect." }, { status: 401 });
    }
    const authResult = (await response.json()) as { idToken?: string; localId?: string };
    if (!authResult.idToken || !authResult.localId) {
      return NextResponse.json({ error: "Email or password is incorrect." }, { status: 401 });
    }

    const authUser = await adminAuth().getUser(authResult.localId);
    const userDoc = await adminDb().collection("users").doc(authResult.localId).get();
    if (authUser.disabled || userDoc.data()?.accountStatus !== "active") {
      return NextResponse.json({ error: "This account is unavailable. Contact your administrator." }, { status: 403 });
    }

    const sessionCookie = await adminAuth().createSessionCookie(authResult.idToken, { expiresIn: SESSION_LIFETIME_MS });
    const result = NextResponse.json({ success: true });
    result.cookies.set(SESSION_COOKIE, sessionCookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(SESSION_LIFETIME_MS / 1000),
    });
    return result;
  } catch (error) {
    return errorResponse(error);
  }
}
