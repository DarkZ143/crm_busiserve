import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminAuth, adminDb, hasAuthApiKey } from "@/lib/firebase-admin";
import { requireSessionUser } from "@/lib/auth";
import { addAuditToBatch, auditEntry, createNotification, getRecord, listRecords, notifyRole } from "@/lib/data";
import { assertSameOrigin, errorResponse, HttpError, parseBody, serializeRecord } from "@/lib/http";
import { consumeRateLimit } from "@/lib/security";
import type { CollectionName } from "@/lib/types";

const collections: CollectionName[] = ["clients", "projects", "projectRequests", "tasks", "milestones", "workReports", "notifications", "auditLogs", "users"];
const requestReviewSchema = z.object({
  action: z.enum(["approve", "request_changes", "reject"]),
  reviewerComments: z.string().trim().max(4000).optional().default(""),
});
const reportReviewSchema = z.object({
  operation: z.literal("review"),
  status: z.enum(["under_review", "changes_requested", "accepted"]),
  reviewerComments: z.string().trim().max(4000).optional().default(""),
});
const reportRevisionSchema = z.object({
  operation: z.literal("revise"),
  workSummary: z.string().trim().min(5).max(240),
  description: z.string().trim().min(10).max(8000),
  tasksCompleted: z.string().trim().max(4000).optional().default(""),
  workInProgress: z.string().trim().max(4000).optional().default(""),
  nextSteps: z.string().trim().max(4000).optional().default(""),
  blockers: z.string().trim().max(4000).optional().default(""),
  timeSpentHours: z.coerce.number().min(0).max(24),
});
const taskUpdateSchema = z.object({
  status: z.enum(["open", "in_progress", "blocked", "completed"]),
  comment: z.string().trim().max(2000).optional(),
});
const projectUpdateSchema = z.object({
  status: z.enum(["draft", "approved", "planning", "in_progress", "on_hold", "blocked", "in_review", "completed", "cancelled", "archived"]),
  progressPercentage: z.coerce.number().int().min(0).max(100).optional(),
  contractPrice: z.coerce.number().nonnegative().optional(),
  currency: z.string().trim().length(3).optional(),
  startDate: z.string().date().optional(),
  expectedEndDate: z.string().date().optional(),
  durationMonths: z.coerce.number().int().min(1).max(120).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assignedTeam: z.array(z.string().min(1)).max(50).optional(),
  assignedCto: z.string().min(1).optional(),
}).refine((value) => value.status !== "completed" || value.progressPercentage === 100, {
  message: "Set progress to 100% before completing a project.",
  path: ["progressPercentage"],
});
const clientUpdateSchema = z.object({
  clientName: z.string().trim().min(2).max(160).optional(),
  contactPerson: z.string().trim().min(2).max(120).optional(),
  officialEmail: z.email().max(254).transform((value) => value.trim().toLowerCase()).optional(),
  contactNumber: z.string().trim().min(7).max(24).optional(),
  companyName: z.string().trim().max(160).optional(),
  businessAddress: z.string().trim().max(500).optional(),
  industry: z.string().trim().max(100).optional(),
  requirements: z.string().trim().max(5000).optional(),
  objectives: z.string().trim().max(3000).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  internalNotes: z.string().trim().max(5000).optional(),
  assignedProductManager: z.string().trim().min(1).optional(),
});
const clientReviewSchema = z.object({
  operation: z.literal("review"),
  action: z.enum(["approve", "reject"]),
  assignedProductManager: z.string().trim().optional(),
  reviewerComments: z.string().trim().max(4000).optional().default(""),
});
const userUpdateSchema = z.object({
  operation: z.enum(["set_status", "change_role"]),
  accountStatus: z.enum(["active", "suspended"]).optional(),
  role: z.enum(["super_admin", "cto", "product_manager", "team_member"]).optional(),
});
const userDeleteSchema = z.object({
  operation: z.literal("delete"),
  password: z.string().min(1).max(128),
});
const notificationUpdateSchema = z.object({ read: z.boolean() });
const milestoneUpdateSchema = z.object({ status: z.enum(["planned", "in_progress", "blocked", "completed"]) });
const projectRequestRevisionSchema = z.object({
  clientId: z.string().min(1),
  projectName: z.string().trim().min(2).max(160),
  projectDescription: z.string().trim().max(5000).optional().default(""),
  requirements: z.string().trim().min(5).max(8000),
  objectives: z.string().trim().max(3000).optional().default(""),
  expectedDurationMonths: z.coerce.number().int().min(1).max(120),
  expectedEndDate: z.string().date().optional(),
  proposedPrice: z.coerce.number().nonnegative().optional(),
  currency: z.string().trim().length(3).optional(),
});

function ensureCollection(value: string): CollectionName {
  if (!collections.includes(value as CollectionName)) throw new HttpError("Record type not found.", 404);
  return value as CollectionName;
}

function isReviewableClient(client: FirebaseFirestore.DocumentData) {
  return client.approvalStatus === "pending" || client.approvalStatus === "rejected"
    || client.approvalStatus === undefined && client.status === "draft";
}

async function reviewRequest(id: string, request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin" && user.role !== "cto") throw new HttpError("You cannot review project requests.", 403);
  const input = await parseBody(request, requestReviewSchema);
  const db = adminDb();
  const ref = db.collection("projectRequests").doc(id);
  const auditRef = db.collection("auditLogs").doc();
  const status = input.action === "approve" ? "approved" : input.action === "reject" ? "rejected" : "changes_requested";
  let data: FirebaseFirestore.DocumentData | undefined;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new HttpError("Project request not found.", 404);
    data = snapshot.data();
    if (user.role === "cto" && data?.assignedCto && data.assignedCto !== user.uid) throw new HttpError("This request is assigned to another CTO.", 403);
    if (!["pending_cto_review", "changes_requested"].includes(String(data?.status))) throw new HttpError("This request has already been reviewed.", 409);
    transaction.update(ref, {
      status,
      reviewerComments: input.reviewerComments,
      reviewedBy: user.uid,
      reviewedAt: FieldValue.serverTimestamp(),
      ...(user.role === "cto" ? { assignedCto: user.uid } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(auditRef, {
      actorUid: user.uid,
      actorName: user.displayName,
      actorRole: user.role,
      action: `project_request_${status}`,
      targetCollection: "projectRequests",
      targetId: id,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  const pmUid = String(data?.assignedProductManager ?? data?.createdBy ?? "");
  if (pmUid) void createNotification(pmUid, `Project request ${status.replaceAll("_", " ")}`, input.reviewerComments || `The request for ${String(data?.projectName ?? "your project")} was updated.`, "/product-manager/project-requests", "project_request_review").catch(() => undefined);
  return { id, status, reviewerComments: input.reviewerComments };
}

async function reviseProjectRequest(id: string, request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "product_manager") throw new HttpError("Only the Product Manager who submitted this request can revise it.", 403);
  const input = await parseBody(request, projectRequestRevisionSchema);
  const db = adminDb();
  const ref = db.collection("projectRequests").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError("Project request not found.", 404);
  const current = snapshot.data()!;
  if (current.createdBy !== user.uid && current.assignedProductManager !== user.uid) throw new HttpError("You cannot revise this project request.", 403);
  if (current.status !== "changes_requested" && current.status !== "draft") throw new HttpError("Only drafts and requests with requested changes can be revised.", 409);
  if (current.clientId !== input.clientId) throw new HttpError("A request must stay linked to its original client.", 400);
  const revisionRef = ref.collection("revisions").doc();
  const auditRef = db.collection("auditLogs").doc();
  const batch = db.batch();
  batch.set(revisionRef, {
    previous: {
      projectName: current.projectName,
      projectDescription: current.projectDescription,
      requirements: current.requirements,
      objectives: current.objectives,
      expectedDurationMonths: current.expectedDurationMonths,
      expectedEndDate: current.expectedEndDate,
      proposedPrice: current.proposedPrice,
      currency: current.currency,
    },
    revisedBy: user.uid,
    revisedAt: FieldValue.serverTimestamp(),
  });
  const nextStatus = current.status === "draft" ? "draft" : "pending_cto_review";
  batch.update(ref, { ...input, status: nextStatus, reviewerComments: "", reviewedBy: null, reviewedAt: null, updatedAt: FieldValue.serverTimestamp(), revisionCount: FieldValue.increment(1) });
  batch.set(auditRef, {
    actorUid: user.uid,
    actorName: user.displayName,
    actorRole: user.role,
    action: "project_request_revised",
    targetCollection: "projectRequests",
    targetId: id,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  if (nextStatus === "pending_cto_review") {
    const reviewerUid = String(current.assignedCto ?? current.reviewedBy ?? "");
    if (reviewerUid) void createNotification(reviewerUid, "Project request revised", `${input.projectName} has been resubmitted for review.`, "/cto/project-requests", "project_request_revised").catch(() => undefined);
    else void notifyRole("cto", "Project request resubmitted", `${input.projectName} is ready for review.`, "/cto/project-requests", "project_request_revised").catch(() => undefined);
  }
  return { id, status: nextStatus };
}

async function submitProjectRequestDraft(id: string, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "product_manager") throw new HttpError("Only a Product Manager can submit this draft.", 403);
  const db = adminDb();
  const ref = db.collection("projectRequests").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError("Project request not found.", 404);
  const current = snapshot.data()!;
  if (current.createdBy !== user.uid && current.assignedProductManager !== user.uid) throw new HttpError("You cannot submit this project request.", 403);
  if (current.status !== "draft") throw new HttpError("Only a draft can be submitted.", 409);
  const batch = db.batch();
  batch.update(ref, { status: "pending_cto_review", updatedAt: FieldValue.serverTimestamp() });
  addAuditToBatch(batch, user, "project_request_submitted", "projectRequests", id, { projectName: current.projectName });
  await batch.commit();
  void notifyRole("cto", "Project request submitted", `${String(current.projectName ?? "A project request")} is ready for review.`, "/cto/project-requests", "project_request").catch(() => undefined);
  return { id, status: "pending_cto_review" };
}

async function updateReport(id: string, request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  const operation = (await parseBody(request.clone(), z.object({ operation: z.string() }))).operation;
  const db = adminDb();
  const ref = db.collection("workReports").doc(id);
  const reportSnapshot = await ref.get();
  if (!reportSnapshot.exists) throw new HttpError("Work report not found.", 404);
  const current = reportSnapshot.data()!;

  if (operation === "review") {
    if (user.role !== "super_admin" && user.role !== "cto") throw new HttpError("You cannot review work reports.", 403);
    const input = await parseBody(request, reportReviewSchema);
    const project = await db.collection("projects").doc(String(current.projectId)).get();
    if (!project.exists || (user.role === "cto" && project.data()?.assignedCto !== user.uid)) throw new HttpError("This report is outside your project scope.", 403);
    if (current.status === "accepted") throw new HttpError("Accepted reports cannot be changed.", 409);
    const batch = db.batch();
    batch.update(ref, {
      status: input.status,
      reviewerComments: input.reviewerComments,
      reviewedBy: user.uid,
      reviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    addAuditToBatch(batch, user, `work_report_${input.status}`, "workReports", id, { projectId: current.projectId });
    await batch.commit();
    if (input.status !== "under_review") {
      void createNotification(String(current.employeeId), input.status === "accepted" ? "Work report accepted" : "Changes requested on your report", input.reviewerComments || "Open your work history to review this report.", "/workspace/history", "report_review").catch(() => undefined);
    }
    return { id, status: input.status, reviewerComments: input.reviewerComments };
  }

  if (operation === "revise") {
    if (user.role !== "team_member" || current.employeeId !== user.uid) throw new HttpError("You can revise only your own reports.", 403);
    if (current.status !== "changes_requested") throw new HttpError("Only reports with requested changes can be revised.", 409);
    const input = await parseBody(request, reportRevisionSchema);
    const revisionRef = ref.collection("revisions").doc();
    const batch = db.batch();
    batch.set(revisionRef, {
      previous: {
        workSummary: current.workSummary,
        description: current.description,
        tasksCompleted: current.tasksCompleted,
        workInProgress: current.workInProgress,
        nextSteps: current.nextSteps,
        blockers: current.blockers,
        timeSpentHours: current.timeSpentHours,
      },
      revisedBy: user.uid,
      revisedAt: FieldValue.serverTimestamp(),
    });
    batch.update(ref, {
      ...input,
      status: "submitted",
      reviewerComments: "",
      reviewedBy: null,
      reviewedAt: null,
      revisionCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
    addAuditToBatch(batch, user, "work_report_revised", "workReports", id, { revisionId: revisionRef.id });
    await batch.commit();
    return { id, status: "submitted" };
  }

  throw new HttpError("Unsupported work report action.", 400);
}

async function updateTask(id: string, request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  const input = await parseBody(request, taskUpdateSchema);
  const db = adminDb();
  const ref = db.collection("tasks").doc(id);
  const [task, projects] = await Promise.all([ref.get(), listRecords("projects", user)]);
  if (!task.exists) throw new HttpError("Task not found.", 404);
  const current = task.data()!;
  const project = projects.find((record) => record.id === current.projectId);
  if (!project) throw new HttpError("This task is outside your project scope.", 403);
  if (user.role === "team_member" && current.assigneeId !== user.uid) throw new HttpError("You can update only your assigned tasks.", 403);
  if (user.role !== "team_member" && user.role !== "cto" && user.role !== "super_admin") throw new HttpError("You cannot update this task.", 403);
  const batch = db.batch();
  batch.update(ref, { status: input.status, ...(input.comment ? { latestComment: input.comment, latestCommentBy: user.uid, latestCommentAt: FieldValue.serverTimestamp() } : {}), updatedAt: FieldValue.serverTimestamp() });
  addAuditToBatch(batch, user, "task_updated", "tasks", id, { status: input.status });
  await batch.commit();
  return { id, status: input.status };
}

async function updateProject(id: string, request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin" && user.role !== "cto") throw new HttpError("You cannot update project status.", 403);
  const input = await parseBody(request, projectUpdateSchema);
  const db = adminDb();
  const ref = db.collection("projects").doc(id);
  const current = await ref.get();
  if (!current.exists) throw new HttpError("Project not found.", 404);
  const currentData = current.data()!;
  if (user.role === "cto" && currentData.assignedCto !== user.uid) throw new HttpError("This project is assigned to another CTO.", 403);
  const nextStartDate = input.startDate ?? String(currentData.startDate ?? "");
  const nextEndDate = input.expectedEndDate ?? String(currentData.expectedEndDate ?? "");
  if (nextStartDate && nextEndDate && nextEndDate < nextStartDate) throw new HttpError("Expected end date must be on or after the start date.", 400);
  if (user.role === "cto" && input.assignedCto !== undefined) throw new HttpError("Only a Super Admin can reassign a project to another CTO.", 403);
  if (input.assignedTeam) {
    const members = await Promise.all(input.assignedTeam.map((uid) => db.collection("users").doc(uid).get()));
    if (members.some((member) => !member.exists || member.data()?.role !== "team_member" || member.data()?.accountStatus !== "active")) {
      throw new HttpError("Choose only active team members for this project.", 400);
    }
  }
  if (input.assignedCto) {
    const cto = await db.collection("users").doc(input.assignedCto).get();
    if (!cto.exists || cto.data()?.role !== "cto" || cto.data()?.accountStatus !== "active") {
      throw new HttpError("Choose an active CTO for this project.", 400);
    }
  }
  const previousTeam = Array.isArray(currentData.assignedTeam) ? currentData.assignedTeam as string[] : [];
  const nextTeam = input.assignedTeam ?? previousTeam;
  const addedMembers = nextTeam.filter((uid) => !previousTeam.includes(uid));
  const removedMembers = input.assignedTeam === undefined ? [] : previousTeam.filter((uid) => !nextTeam.includes(uid));
  const changes = {
    status: input.status,
    ...(input.progressPercentage !== undefined ? { progressPercentage: input.progressPercentage } : {}),
    ...(input.contractPrice !== undefined ? { contractPrice: input.contractPrice } : {}),
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
    ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
    ...(input.expectedEndDate !== undefined ? { expectedEndDate: input.expectedEndDate } : {}),
    ...(input.durationMonths !== undefined ? { durationMonths: input.durationMonths } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.assignedTeam !== undefined ? { assignedTeam: input.assignedTeam } : {}),
    ...(input.assignedCto !== undefined ? { assignedCto: input.assignedCto } : {}),
    updatedAt: FieldValue.serverTimestamp(),
    ...(input.status === "completed" && currentData.status !== "completed" ? { actualCompletionDate: new Date().toISOString().slice(0, 10) } : {}),
    ...(input.status !== "completed" && currentData.status === "completed" ? { actualCompletionDate: null } : {}),
  };
  const batch = db.batch();
  batch.update(ref, changes);
  addAuditToBatch(batch, user, "project_updated", "projects", id, {
    status: input.status,
    progressPercentage: input.progressPercentage,
    contractPrice: input.contractPrice,
    currency: input.currency,
    startDate: input.startDate,
    expectedEndDate: input.expectedEndDate,
    durationMonths: input.durationMonths,
    priority: input.priority,
    ...(input.assignedTeam !== undefined ? { assignedTeam: input.assignedTeam } : {}),
    ...(input.assignedCto !== undefined ? { assignedCto: input.assignedCto } : {}),
  });
  await batch.commit();
  for (const uid of addedMembers) {
    void createNotification(uid, "Project assignment", `You have been assigned to ${String(current.data()?.name ?? "a project")}.`, "/workspace/projects", "project_assigned").catch(() => undefined);
  }
  for (const uid of removedMembers) {
    void createNotification(uid, "Project assignment updated", `You are no longer assigned to ${String(currentData.name ?? "a project")}.`, "/workspace/projects", "project_unassigned").catch(() => undefined);
  }
  const assignedProductManager = String(currentData.assignedProductManager ?? "");
  if (assignedProductManager && (input.status !== currentData.status || input.progressPercentage !== undefined)) {
    void createNotification(assignedProductManager, "Project update", `${String(currentData.name ?? "A project")} status: ${input.status.replaceAll("_", " ")}${input.progressPercentage === undefined ? "" : ` · ${input.progressPercentage}% complete`}.`, "/product-manager/updates", "project_updated").catch(() => undefined);
  }
  if (input.assignedCto && input.assignedCto !== current.data()?.assignedCto) {
    void createNotification(input.assignedCto, "Project assigned", `${String(currentData.name ?? "A project")} is now assigned to you.`, "/cto/projects", "project_assigned").catch(() => undefined);
  }
  return { id, status: input.status, progressPercentage: input.progressPercentage, assignedTeam: input.assignedTeam, assignedCto: input.assignedCto };
}

async function updateMilestone(id: string, request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin" && user.role !== "cto") throw new HttpError("Only a CTO or Super Admin can update milestones.", 403);
  const input = await parseBody(request, milestoneUpdateSchema);
  const db = adminDb();
  const ref = db.collection("milestones").doc(id);
  const milestone = await ref.get();
  if (!milestone.exists) throw new HttpError("Milestone not found.", 404);
  const project = await db.collection("projects").doc(String(milestone.data()?.projectId)).get();
  if (!project.exists || (user.role === "cto" && project.data()?.assignedCto !== user.uid)) throw new HttpError("This milestone is outside your project scope.", 403);
  const batch = db.batch();
  batch.update(ref, { status: input.status, updatedAt: FieldValue.serverTimestamp() });
  addAuditToBatch(batch, user, "milestone_status_updated", "milestones", id, { status: input.status });
  await batch.commit();
  return { id, status: input.status };
}

async function updateClient(id: string, request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin" && user.role !== "product_manager") throw new HttpError("You cannot edit client records.", 403);
  const input = await parseBody(request, clientUpdateSchema);
  const db = adminDb();
  const ref = db.collection("clients").doc(id);
  const current = await ref.get();
  if (!current.exists) throw new HttpError("Client not found.", 404);
  if (user.role === "product_manager" && current.data()?.createdBy !== user.uid && current.data()?.assignedProductManager !== user.uid) throw new HttpError("You cannot edit this client.", 403);
  if (user.role === "product_manager" && input.assignedProductManager !== undefined) throw new HttpError("You cannot reassign this client.", 403);
  if (user.role !== "super_admin" && input.status !== undefined) throw new HttpError("Only a Super Admin can change client status.", 403);
  if (user.role !== "super_admin" && input.internalNotes !== undefined) throw new HttpError("Only a Super Admin can edit internal notes.", 403);
  if (input.assignedProductManager) {
    const manager = await db.collection("users").doc(input.assignedProductManager).get();
    if (!manager.exists || manager.data()?.role !== "product_manager" || manager.data()?.accountStatus !== "active") {
      throw new HttpError("Choose an active Product Manager for this client.", 400);
    }
  }
  const changes = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const update = {
    ...changes,
    ...(input.officialEmail ? { officialEmailNormalized: input.officialEmail } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const batch = db.batch();
  batch.update(ref, update);
  addAuditToBatch(batch, user, "client_updated", "clients", id, { changedFields: Object.keys(changes) });
  await batch.commit();
  return { id, ...changes };
}

async function reviewClient(id: string, request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin") throw new HttpError("Only a Super Admin can approve client records.", 403);
  const input = await parseBody(request, clientReviewSchema);
  const db = adminDb();
  const ref = db.collection("clients").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError("Client not found.", 404);
  const current = snapshot.data()!;
  if (!isReviewableClient(current)) throw new HttpError("This client is no longer awaiting approval.", 409);

  let assignedProductManager = "";
  if (input.action === "approve" && input.assignedProductManager) {
    const manager = await db.collection("users").doc(input.assignedProductManager).get();
    if (!manager.exists || manager.data()?.role !== "product_manager" || manager.data()?.accountStatus !== "active") {
      throw new HttpError("Choose an active Product Manager for this client.", 400);
    }
    assignedProductManager = input.assignedProductManager;
  }

  const changes = {
    approvalStatus: input.action === "approve" ? "approved" : "rejected",
    approvalComments: input.reviewerComments,
    reviewedBy: user.uid,
    reviewedAt: FieldValue.serverTimestamp(),
    ...(input.action === "approve" ? { ...(assignedProductManager ? { assignedProductManager } : {}), status: "active" } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const auditRef = db.collection("auditLogs").doc();
  await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(ref);
    if (!latest.exists) throw new HttpError("Client not found.", 404);
    if (!latest.data() || !isReviewableClient(latest.data()!)) throw new HttpError("This client is no longer awaiting approval.", 409);
    transaction.update(ref, changes);
    transaction.set(auditRef, auditEntry(user, input.action === "approve" ? "client_approved" : "client_rejected", "clients", id, {
      clientName: String(current.clientName ?? ""),
      ...(input.action === "approve" ? { assignedProductManager } : {}),
      ...(input.reviewerComments ? { reviewerComments: input.reviewerComments } : {}),
    }));
  });

  const creator = String(current.createdBy ?? "");
  if (creator) {
    const profile = await db.collection("users").doc(creator).get();
    const role = profile.data()?.role;
    const href = role === "product_manager" ? "/product-manager/clients" : role === "cto" ? "/cto/clients" : "/workspace/clients";
    void createNotification(
      creator,
      input.action === "approve" ? "Client approved" : "Client submission reviewed",
      input.action === "approve"
        ? `${String(current.clientName ?? "Your client") } is approved and ready to use.`
        : `${String(current.clientName ?? "Your client")} was not approved.${input.reviewerComments ? ` ${input.reviewerComments}` : ""}`,
      href,
      input.action === "approve" ? "client_approved" : "client_rejected",
    ).catch(() => undefined);
  }
  return { id, ...changes };
}

async function updateUser(id: string, request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin") throw new HttpError("Only a Super Admin can manage accounts.", 403);
  if (id === user.uid) throw new HttpError("You cannot change your own role or account status.", 403);
  const input = await parseBody(request, userUpdateSchema);
  const db = adminDb();
  const ref = db.collection("users").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError("User not found.", 404);
  const current = snapshot.data()!;
  if (current.deletionPending) throw new HttpError("This account is being deleted. Retry the delete action to finish.", 409);
  if (input.operation === "set_status" && !input.accountStatus) throw new HttpError("Choose an account status.", 400);
  if (input.operation === "change_role" && !input.role) throw new HttpError("Choose a role.", 400);
  const nextRole = input.role ?? current.role;
  const nextStatus = input.accountStatus ?? current.accountStatus;
  if (current.role === "super_admin" && (nextRole !== "super_admin" || nextStatus !== "active")) {
    const activeAdmins = await db.collection("users").where("role", "==", "super_admin").where("accountStatus", "==", "active").get();
    if (activeAdmins.size <= 1) throw new HttpError("The last active Super Admin cannot be suspended or demoted.", 409);
  }
  await adminAuth().setCustomUserClaims(id, { role: nextRole });
  await adminAuth().updateUser(id, { disabled: nextStatus !== "active" });
  const batch = db.batch();
  batch.update(ref, { role: nextRole, accountStatus: nextStatus, updatedAt: FieldValue.serverTimestamp() });
  addAuditToBatch(batch, user, input.operation === "change_role" ? "user_role_changed" : "user_account_status_changed", "users", id, { role: nextRole, accountStatus: nextStatus });
  await batch.commit();
  return { id, role: nextRole, accountStatus: nextStatus };
}

async function verifySuperAdminPassword(password: string, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (!hasAuthApiKey()) throw new HttpError("Firebase Authentication is not configured for password verification.", 503);

  const attempt = await consumeRateLimit(`user-deletion-password:${user.uid}`, 5, 60 * 60 * 1000);
  if (!attempt.allowed) throw new HttpError("Too many password attempts. Try again in one hour.", 429);

  const authUser = await adminAuth().getUser(user.uid);
  if (!authUser.email) throw new HttpError("The Super Admin account does not have a sign-in email.", 400);
  let response: Response;
  try {
    response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(process.env.FIREBASE_API_KEY!)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authUser.email, password, returnSecureToken: true }),
        cache: "no-store",
      },
    );
  } catch {
    throw new HttpError("Password verification is temporarily unavailable. Try again.", 503);
  }

  let localId = "";
  let authError = "";
  try {
    const result = await response.json() as { localId?: string; error?: { message?: string } };
    localId = String(result.localId ?? "");
    authError = String(result.error?.message ?? "");
  } catch {
    throw new HttpError("Password verification is temporarily unavailable. Try again.", 503);
  }
  if (response.ok && localId === user.uid) return;

  if (["INVALID_PASSWORD", "INVALID_LOGIN_CREDENTIALS", "EMAIL_NOT_FOUND"].includes(authError)) {
    const remaining = attempt.remaining;
    const message = remaining === 0
      ? "Incorrect Super Admin password. The limit is reached; try again in one hour."
      : `Incorrect Super Admin password. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining this hour.`;
    throw new HttpError(message, 401);
  }
  if (authError === "TOO_MANY_ATTEMPTS_TRY_LATER") {
    throw new HttpError("Firebase temporarily blocked password checks. Try again later.", 429);
  }
  throw new HttpError("Password verification could not be completed. Try again.", 503);
}

async function deleteTeamMember(id: string, request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin") throw new HttpError("Only a Super Admin can delete team members.", 403);
  if (id === user.uid) throw new HttpError("You cannot delete your own account.", 403);
  const input = await parseBody(request, userDeleteSchema);
  const db = adminDb();
  const profileRef = db.collection("users").doc(id);
  const initialProfile = await profileRef.get();
  if (!initialProfile.exists) throw new HttpError("Team member not found.", 404);
  if (initialProfile.data()?.role !== "team_member") throw new HttpError("Only a team member account can be deleted here.", 403);

  await verifySuperAdminPassword(input.password, user);

  const existingStatus = String(initialProfile.data()?.accountStatus ?? "active");
  const wasAlreadyPending = Boolean(initialProfile.data()?.deletionPending);
  if (wasAlreadyPending && existingStatus !== "suspended") {
    throw new HttpError("This account has an invalid deletion state. Contact support.", 409);
  }
  await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(profileRef);
    if (!latest.exists) throw new HttpError("Team member not found.", 404);
    if (latest.data()?.role !== "team_member") throw new HttpError("Only a team member account can be deleted here.", 403);
    if (latest.data()?.deletionPending && !wasAlreadyPending) throw new HttpError("This account is already being deleted. Retry the delete action shortly.", 409);
    if (!latest.data()?.deletionPending) {
      transaction.update(profileRef, {
        accountStatus: "suspended",
        deletionPending: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });

  try {
    await adminAuth().deleteUser(id);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "auth/user-not-found") {
      if (!wasAlreadyPending) {
        await profileRef.update({
          accountStatus: existingStatus,
          deletionPending: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        }).catch(() => undefined);
      }
      throw new HttpError("The team member account could not be deleted. Try again.", 503);
    }
  }

  const retiredIdRef = db.collection("deletedUserIds").doc(id);
  const auditRef = db.collection("auditLogs").doc();
  await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(profileRef);
    if (!latest.exists) throw new HttpError("Team member not found.", 404);
    if (latest.data()?.role !== "team_member" || !latest.data()?.deletionPending) {
      throw new HttpError("The account changed while it was being deleted. Refresh and try again.", 409);
    }
    transaction.delete(profileRef);
    transaction.set(retiredIdRef, {
      deletedAt: FieldValue.serverTimestamp(),
      deletedBy: user.uid,
    });
    transaction.set(auditRef, auditEntry(user, "user_deleted", "users", id, {
      role: "team_member",
      displayName: String(latest.data()?.displayName ?? ""),
      email: String(latest.data()?.email ?? ""),
    }));
  });
  return { id, deleted: true };
}

export async function PATCH(request: Request, context: { params: Promise<{ collection: string; id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireSessionUser();
    const { collection: rawCollection, id } = await context.params;
    const collection = ensureCollection(rawCollection);
    if (user.role !== "super_admin") {
      throw new HttpError("Only a Super Admin can update workspace records.", 403);
    }
    let result;
    if (collection === "projectRequests") {
      const operation = (await parseBody(request.clone(), z.object({ action: z.string().optional() }))).action;
      result = operation === "revise" ? await reviseProjectRequest(id, request, user)
        : operation === "submit_draft" ? await submitProjectRequestDraft(id, user)
          : await reviewRequest(id, request, user);
    }
    else if (collection === "workReports") result = await updateReport(id, request, user);
    else if (collection === "tasks") result = await updateTask(id, request, user);
    else if (collection === "projects") result = await updateProject(id, request, user);
    else if (collection === "milestones") result = await updateMilestone(id, request, user);
    else if (collection === "clients") {
      const operation = (await parseBody(request.clone(), z.object({ operation: z.string().optional() }))).operation;
      result = operation === "review" ? await reviewClient(id, request, user) : await updateClient(id, request, user);
    }
    else if (collection === "users") {
      const operation = (await parseBody(request.clone(), z.object({ operation: z.string().optional() }))).operation;
      result = operation === "delete" ? await deleteTeamMember(id, request, user) : await updateUser(id, request, user);
    }
    else if (collection === "notifications") {
      const input = await parseBody(request, notificationUpdateSchema);
      const record = await getRecord("notifications", id);
      if (!record || record.recipientUid !== user.uid) throw new HttpError("Notification not found.", 404);
      await adminDb().collection("notifications").doc(id).update({ readAt: input.read ? FieldValue.serverTimestamp() : null });
      result = { id, read: input.read };
    } else throw new HttpError("This record type cannot be updated here.", 405);
    return NextResponse.json({ record: serializeRecord(result) });
  } catch (error) {
    return errorResponse(error);
  }
}
