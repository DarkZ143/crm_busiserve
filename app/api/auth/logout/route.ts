import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { assertSameOrigin, errorResponse } from "@/lib/http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const result = NextResponse.json({ success: true });
    result.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return result;
  } catch (error) {
    return errorResponse(error);
  }
}
