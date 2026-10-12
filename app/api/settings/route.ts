import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { addAuditToBatch } from "@/lib/data";
import { adminDb } from "@/lib/firebase-admin";
import { assertSameOrigin, errorResponse, HttpError, parseBody } from "@/lib/http";

const settingsSchema = z.object({
  timezone: z.string().trim().min(1).max(100),
});

export async function GET() {
  try {
    await requireRole("super_admin");
    const snapshot = await adminDb().doc("companySettings/general").get();
    return NextResponse.json({ settings: { timezone: String(snapshot.data()?.timezone ?? "Asia/Kolkata") } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireRole("super_admin");
    const input = await parseBody(request, settingsSchema);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
    } catch {
      throw new HttpError("Enter a valid IANA timezone, such as Asia/Kolkata.", 400);
    }
    const db = adminDb();
    const batch = db.batch();
    batch.set(db.doc("companySettings/general"), {
      timezone: input.timezone,
      updatedBy: user.uid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    addAuditToBatch(batch, user, "company_timezone_updated", "companySettings", "general", { timezone: input.timezone });
    await batch.commit();
    return NextResponse.json({ settings: input });
  } catch (error) {
    return errorResponse(error);
  }
}
