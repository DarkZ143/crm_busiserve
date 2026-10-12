import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";
import { ZodError } from "zod";

export function errorResponse(error: unknown) {
  if (error instanceof HttpError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "Check the highlighted fields and try again.", fields: error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  if (error instanceof Error && error.message === "Firebase Admin is not configured.") {
    return NextResponse.json({ error: "Firebase is not configured for this environment." }, { status: 503 });
  }
  console.error("Request failed", error instanceof Error ? error.name : "Unknown error");
  return NextResponse.json({ error: "The request could not be completed." }, { status: 500 });
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

export async function parseBody<T>(request: Request, schema: { parse: (value: unknown) => T }) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError("The request body must be valid JSON.", 400);
  }
  return schema.parse(body);
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) throw new AuthError("Cross-origin request rejected.", 403);
}

export function serializeRecord(value: unknown): unknown {
  if (value && typeof value === "object") {
    if ("toDate" in value && typeof value.toDate === "function") {
      return (value.toDate() as Date).toISOString();
    }
    if (Array.isArray(value)) return value.map(serializeRecord);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeRecord(entry)]),
    );
  }
  return value;
}
