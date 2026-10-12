import { NextResponse } from "next/server";
import { z } from "zod";
import { hasAuthApiKey } from "@/lib/firebase-admin";
import { assertSameOrigin, errorResponse } from "@/lib/http";
import { consumeRateLimit, requestIdentity } from "@/lib/security";

const emailSchema = z.object({ email: z.email().max(254).transform((email) => email.trim().toLowerCase()) });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (!hasAuthApiKey()) {
      return NextResponse.json({ error: "Firebase Authentication is not configured." }, { status: 503 });
    }
    const { email } = emailSchema.parse(await request.json());
    const limit = await consumeRateLimit(`password-reset:${requestIdentity(request)}:${email}`, 4, 60 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json({ error: "Please wait before requesting another reset email." }, { status: 429 });
    }
    await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(process.env.FIREBASE_API_KEY!)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestType: "PASSWORD_RESET", email }),
        cache: "no-store",
      },
    );
    return NextResponse.json({
      success: true,
      message: "If an account matches that address, a recovery email will be sent.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
