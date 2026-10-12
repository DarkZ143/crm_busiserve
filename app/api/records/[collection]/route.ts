import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { requireSessionUser } from "@/lib/auth";
import { addAuditToBatch, auditEntry, createNotification, listRecords, notifyRole } from "@/lib/data";
import { redactRecordForRole } from "@/lib/record-security";
import { assertSameOrigin, errorResponse, HttpError, parseBody, serializeRecord } from "@/lib/http";
import type { CollectionName } from "@/lib/types";

const collectionNames: CollectionName[] = ["clients", "projects", "projectRequests", "tasks", "milestones", "workReports", "notifications", "auditLogs", "users"];
const roles = ["super_admin", "cto", "product_manager", "team_member"] as const;

const clientSchema = z.object({
  clientName: z.string().trim().min(2).max(160),
  contactPerson: z.string().trim().min(2).max(120),
  officialEmail: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  contactNumber: z.string().trim().min(7).max(24),
  companyName: z.string().trim().max(160).optional().default(""),
  businessAddress: z.string().trim().max(500).optional().default(""),
  industry: z.string().trim().max(100).optional().default(""),
  requirements: z.string().trim().max(5000).optional().default(""),
  objectives: z.string().trim().max(3000).optional().default(""),
  onboardingDate: z.string().date().optional().default(new Date().toISOString().slice(0, 10)),
  status: z.enum(["draft", "active", "archived"]).optional().default("active"),
  internalNotes: z.string().trim().max(5000).optional().default(""),
  assignedProductManager: z.string().trim().optional(),
});

const projectRequestSchema = z.object({
  clientId: z.string().min(1),
  projectName: z.string().trim().min(2).max(160),
  projectDescription: z.string().trim().max(5000).optional().default(""),
  requirements: z.string().trim().min(5).max(8000),
  objectives: z.string().trim().max(3000).optional().default(""),
  expectedDurationMonths: z.coerce.number().int().min(1).max(120),
  expectedEndDate: z.string().date().optional(),
  proposedPrice: z.coerce.number().nonnegative().optional(),
  currency: z.string().trim().length(3).optional().default("INR"),
  status: z.enum(["draft", "pending_cto_review"]).optional().default("pending_cto_review"),
});

const idList = z.preprocess(
  (value) => typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : value,
  z.array(z.string().min(1)).max(50),
);

const projectSchema = z.object({
  clientId: z.string().min(1),
  projectRequestId: z.string().optional(),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(5000).optional().default(""),
  category: z.string().trim().max(100).optional().default(""),
  scopeOfWork: z.string().trim().max(8000).optional().default(""),
  requirements: z.string().trim().max(8000).optional().default(""),
  deliverables: z.string().trim().max(5000).optional().default(""),
  contractPrice: z.coerce.number().nonnegative().optional(),
  currency: z.string().trim().length(3).optional().default("INR"),
  startDate: z.string().date().optional(),
  expectedEndDate: z.string().date().optional(),
  durationMonths: z.coerce.number().int().min(1).max(120).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional().default("normal"),
  status: z.enum(["planning", "in_progress", "on_hold", "blocked", "in_review"]).optional().default("planning"),
  assignedCto: z.string().optional(),
  assignedTeam: idList.optional().default([]),
}).refine((record) => !record.startDate || !record.expectedEndDate || record.expectedEndDate >= record.startDate, {
  message: "Expected end date must be after the start date.",
  path: ["expectedEndDate"],
});

const taskSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(2).max(180),
  description: z.string().trim().max(5000).optional().default(""),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional().default("normal"),
  dueDate: z.string().date().optional(),
  assigneeId: z.string().min(1),
});

const milestoneSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(2).max(180),
  description: z.string().trim().max(4000).optional().default(""),
  dueDate: z.string().date(),
  sequence: z.coerce.number().int().min(1).max(500).optional(),
});

const reportSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().optional(),
  workDate: z.string().date(),
  workSummary: z.string().trim().min(5).max(240),
  description: z.string().trim().min(10).max(8000),
  tasksCompleted: z.string().trim().max(4000).optional().default(""),
  workInProgress: z.string().trim().max(4000).optional().default(""),
  nextSteps: z.string().trim().max(4000).optional().default(""),
  blockers: z.string().trim().max(4000).optional().default(""),
  timeSpentHours: z.coerce.number().min(0).max(24),
});

const inviteSchema = z.object({
  displayName: z.string().trim().min(2).max(100),
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  role: z.enum(roles),
  designation: z.string().trim().max(100).optional().default(""),
});

function ensureCollection(value: string): CollectionName {
  if (!collectionNames.includes(value as CollectionName)) throw new HttpError("Record type not found.", 404);
  return value as CollectionName;
}

async function createClient(request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin" && user.role !== "product_manager") throw new HttpError("You cannot create client records.", 403);
  const input = await parseBody(request, clientSchema);
  const db = adminDb();
  const assignedProductManager = user.role === "product_manager" ? user.uid : input.assignedProductManager || user.uid;
  const manager = await db.collection("users").doc(assignedProductManager).get();
  if (!manager.exists || manager.data()?.role !== "product_manager" || manager.data()?.accountStatus !== "active") {
    throw new HttpError("Choose an active Product Manager for this client.", 400);
  }
  const ref = db.collection("clients").doc();
  const auditRef = db.collection("auditLogs").doc();
  const record = {
    ...input,
    id: ref.id,
    clientId: `CLI-${ref.id.slice(0, 8).toUpperCase()}`,
    officialEmailNormalized: input.officialEmail,
    assignedProductManager,
    createdBy: user.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db.runTransaction(async (transaction) => {
    const duplicate = await transaction.get(db.collection("clients").where("officialEmailNormalized", "==", input.officialEmail).limit(1));
    if (!duplicate.empty) throw new HttpError("A client already exists with this email address.", 409);
    transaction.set(ref, record);
    transaction.set(auditRef, auditEntry(user, "client_created", "clients", ref.id, { clientName: input.clientName }));
  });
  return redactRecordForRole("clients", { id: ref.id, ...input, clientId: `CLI-${ref.id.slice(0, 8).toUpperCase()}` }, user.role);
}

async function createProjectRequest(request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin" && user.role !== "product_manager") throw new HttpError("Only a Product Manager can submit a project request.", 403);
  const input = await parseBody(request, projectRequestSchema);
  const db = adminDb();
  const client = await db.collection("clients").doc(input.clientId).get();
  if (!client.exists) throw new HttpError("The selected client was not found.", 404);
  if (user.role === "product_manager" && client.data()?.createdBy !== user.uid && client.data()?.assignedProductManager !== user.uid) throw new HttpError("You cannot submit a request for this client.", 403);
  const ref = db.collection("projectRequests").doc();
  const batch = db.batch();
  batch.set(ref, {
    ...input,
    id: ref.id,
    status: input.status,
    assignedProductManager: user.role === "product_manager" ? user.uid : String(client.data()?.assignedProductManager ?? ""),
    createdBy: user.uid,
    clientName: client.data()?.clientName ?? "",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  addAuditToBatch(batch, user, input.status === "draft" ? "project_request_draft_saved" : "project_request_submitted", "projectRequests", ref.id, { projectName: input.projectName });
  await batch.commit();
  if (input.status === "pending_cto_review") {
    void notifyRole("cto", "Project request submitted", `${input.projectName} is ready for review.`, "/cto/project-requests", "project_request").catch(() => undefined);
  }
  return redactRecordForRole("projectRequests", { id: ref.id, ...input }, user.role);
}

async function createProject(request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin" && user.role !== "cto") throw new HttpError("You cannot create projects.", 403);
  const input = await parseBody(request, projectSchema);
  const db = adminDb();
  const [client, members] = await Promise.all([
    db.collection("clients").doc(input.clientId).get(),
    Promise.all(input.assignedTeam.map((uid) => db.collection("users").doc(uid).get())),
  ]);
  if (!client.exists) throw new HttpError("The selected client was not found.", 404);
  if (members.some((member) => !member.exists || member.data()?.role !== "team_member" || member.data()?.accountStatus !== "active")) {
    throw new HttpError("Only active team members can be assigned to a project.", 400);
  }
  const assignedCto = user.role === "cto" ? user.uid : input.assignedCto;
  if (user.role === "super_admin" && !assignedCto) throw new HttpError("Choose an active CTO for this project.", 400);
  if (user.role === "super_admin" && assignedCto) {
    const cto = await db.collection("users").doc(assignedCto).get();
    if (!cto.exists || cto.data()?.role !== "cto" || cto.data()?.accountStatus !== "active") throw new HttpError("Choose an active CTO.", 400);
  }
  const ref = db.collection("projects").doc();
  const record = {
    ...input,
    id: ref.id,
    projectId: `PRJ-${ref.id.slice(0, 8).toUpperCase()}`,
    assignedCto,
    assignedProductManager: client.data()?.assignedProductManager ?? "",
    assignedTeam: input.assignedTeam,
    createdBy: user.uid,
    progressPercentage: 0,
    actualCompletionDate: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (input.projectRequestId) {
    const requestRef = db.collection("projectRequests").doc(input.projectRequestId);
    const auditRef = db.collection("auditLogs").doc();
    await db.runTransaction(async (transaction) => {
      const requestSnapshot = await transaction.get(requestRef);
      const requestData = requestSnapshot.data();
      if (!requestSnapshot.exists || requestData?.status !== "approved" || requestData.projectId || requestData.clientId !== input.clientId) {
        throw new HttpError("Choose an approved request that has not been converted yet.", 409);
      }
      transaction.set(ref, record);
      transaction.update(requestRef, { projectId: ref.id, convertedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      transaction.set(auditRef, auditEntry(user, "project_created", "projects", ref.id, { name: input.name, contractPrice: input.contractPrice, currency: input.currency, assignedTeam: input.assignedTeam }));
    });
  } else {
    const batch = db.batch();
    batch.set(ref, record);
    addAuditToBatch(batch, user, "project_created", "projects", ref.id, { name: input.name, contractPrice: input.contractPrice, currency: input.currency, assignedTeam: input.assignedTeam });
    await batch.commit();
  }
  for (const uid of input.assignedTeam) {
    void createNotification(uid, "New project assignment", `You have been assigned to ${input.name}.`, "/workspace/projects", "project_assignment").catch(() => undefined);
  }
  return redactRecordForRole("projects", { id: ref.id, ...input, assignedCto, assignedTeam: input.assignedTeam, progressPercentage: 0 }, user.role);
}

async function createTask(request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin" && user.role !== "cto") throw new HttpError("Only a CTO or Super Admin can assign tasks.", 403);
  const input = await parseBody(request, taskSchema);
  const db = adminDb();
  const [project, assignee] = await Promise.all([
    db.collection("projects").doc(input.projectId).get(),
    db.collection("users").doc(input.assigneeId).get(),
  ]);
  if (!project.exists || (user.role === "cto" && project.data()?.assignedCto !== user.uid)) throw new HttpError("The selected project is unavailable.", 404);
  const assignedTeam = (project.data()?.assignedTeam ?? []) as string[];
  if (!assignedTeam.includes(input.assigneeId) || !assignee.exists || assignee.data()?.role !== "team_member" || assignee.data()?.accountStatus !== "active") {
    throw new HttpError("Assign tasks to an active member of this project team.", 400);
  }
  const ref = db.collection("tasks").doc();
  const batch = db.batch();
  batch.set(ref, { ...input, id: ref.id, status: "open", assigneeName: assignee.data()?.displayName ?? "", createdBy: user.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  addAuditToBatch(batch, user, "task_assigned", "tasks", ref.id, { projectId: input.projectId, assigneeId: input.assigneeId });
  await batch.commit();
  void createNotification(input.assigneeId, "A task was assigned to you", input.title, "/workspace/tasks", "task_assignment").catch(() => undefined);
  return { id: ref.id, ...input, status: "open" };
}

async function createMilestone(request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin" && user.role !== "cto") throw new HttpError("Only a CTO or Super Admin can add milestones.", 403);
  const input = await parseBody(request, milestoneSchema);
  const db = adminDb();
  const project = await db.collection("projects").doc(input.projectId).get();
  if (!project.exists || (user.role === "cto" && project.data()?.assignedCto !== user.uid)) throw new HttpError("The selected project is unavailable.", 404);
  const ref = db.collection("milestones").doc();
  const batch = db.batch();
  batch.set(ref, { ...input, id: ref.id, status: "planned", createdBy: user.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  addAuditToBatch(batch, user, "milestone_created", "milestones", ref.id, { projectId: input.projectId, title: input.title });
  await batch.commit();
  const productManager = String(project.data()?.assignedProductManager ?? "");
  if (productManager) void createNotification(productManager, "Project milestone added", `${input.title} is now on the project timeline.`, "/product-manager/projects", "milestone_created").catch(() => undefined);
  return { id: ref.id, ...input, status: "planned" };
}

async function createReport(request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "team_member") throw new HttpError("Only team members can submit work reports.", 403);
  const input = await parseBody(request, reportSchema);
  const db = adminDb();
  const project = await db.collection("projects").doc(input.projectId).get();
  const assignedTeam = (project.data()?.assignedTeam ?? []) as string[];
  if (!project.exists || !assignedTeam.includes(user.uid)) throw new HttpError("You can submit reports only for your assigned projects.", 403);
  if (input.taskId) {
    const task = await db.collection("tasks").doc(input.taskId).get();
    if (!task.exists || task.data()?.projectId !== input.projectId || task.data()?.assigneeId !== user.uid) {
      throw new HttpError("Choose one of your tasks in this project.", 400);
    }
  }
  const duplicateQuery = db.collection("workReports")
    .where("projectId", "==", input.projectId)
    .where("employeeId", "==", user.uid)
    .where("workDate", "==", input.workDate)
    .where("taskId", "==", input.taskId ?? null)
    .limit(1);
  const ref = db.collection("workReports").doc();
  const auditRef = db.collection("auditLogs").doc();
  const record = {
    ...input,
    taskId: input.taskId ?? null,
    id: ref.id,
    employeeId: user.uid,
    employeeName: user.displayName,
    status: "submitted",
    reviewerComments: "",
    reviewedBy: null,
    reviewedAt: null,
    submittedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db.runTransaction(async (transaction) => {
    const duplicates = await transaction.get(duplicateQuery);
    if (!duplicates.empty) throw new HttpError("A report already exists for this project, task, and work date. Use the correction workflow if changes were requested.", 409);
    transaction.set(ref, record);
    transaction.set(auditRef, auditEntry(user, "work_report_submitted", "workReports", ref.id, { projectId: input.projectId, workDate: input.workDate }));
  });
  const ctoUid = String(project.data()?.assignedCto ?? "");
  if (ctoUid) void createNotification(ctoUid, "Work report submitted", `${user.displayName} submitted a report for ${String(project.data()?.name ?? "a project")}.`, "/cto/reports", "report_submitted").catch(() => undefined);
  return { id: ref.id, ...input, status: "submitted" };
}

async function inviteUser(request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin") throw new HttpError("Only a Super Admin can invite users.", 403);
  const input = await parseBody(request, inviteSchema);
  const db = adminDb();
  let authUser;
  try {
    authUser = await adminAuth().createUser({
      email: input.email,
      displayName: input.displayName,
      password: `${randomUUID()}aA1!`,
      disabled: false,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "auth/email-already-exists") throw new HttpError("An account already exists for this email.", 409);
    throw error;
  }
  let inviteLink: string;
  try {
    await adminAuth().setCustomUserClaims(authUser.uid, { role: input.role });
    const continueUrl = process.env.APP_ORIGIN;
    inviteLink = await adminAuth().generatePasswordResetLink(input.email, continueUrl ? { url: `${continueUrl}/login`, handleCodeInApp: false } : undefined);
    const batch = db.batch();
    batch.set(db.collection("users").doc(authUser.uid), {
      uid: authUser.uid,
      displayName: input.displayName,
      email: input.email,
      role: input.role,
      designation: input.designation,
      accountStatus: "active",
      createdBy: user.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    addAuditToBatch(batch, user, "user_invited", "users", authUser.uid, { role: input.role, email: input.email });
    await batch.commit();
  } catch (error) {
    await adminAuth().deleteUser(authUser.uid).catch(() => undefined);
    throw error;
  }
  return { id: authUser.uid, displayName: input.displayName, email: input.email, role: input.role, inviteLink };
}

export async function GET(_request: Request, context: { params: Promise<{ collection: string }> }) {
  try {
    const user = await requireSessionUser();
    const { collection: rawCollection } = await context.params;
    const collection = ensureCollection(rawCollection);
    const records = await listRecords(collection, user);
    return NextResponse.json({ records });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ collection: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireSessionUser();
    const { collection: rawCollection } = await context.params;
    const collection = ensureCollection(rawCollection);
    let record;
    if (collection === "clients") record = await createClient(request, user);
    else if (collection === "projectRequests") record = await createProjectRequest(request, user);
    else if (collection === "projects") record = await createProject(request, user);
    else if (collection === "tasks") record = await createTask(request, user);
    else if (collection === "milestones") record = await createMilestone(request, user);
    else if (collection === "workReports") record = await createReport(request, user);
    else if (collection === "users") record = await inviteUser(request, user);
    else throw new HttpError("This record type cannot be created here.", 405);
    return NextResponse.json({ record: serializeRecord(record) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
