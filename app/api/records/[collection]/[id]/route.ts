import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminAuth, adminDb, hasAuthApiKey } from "@/lib/firebase-admin";
import { requireSessionUser } from "@/lib/auth";
import { isWorkspaceMember } from "@/lib/access-control";
import { addAuditToBatch, auditEntry, createNotification, getRecord, listRecords, notifyRole } from "@/lib/data";
import { assertSameOrigin, errorResponse, HttpError, parseBody, serializeRecord } from "@/lib/http";
import { consumeRateLimit } from "@/lib/security";
import { checkPhone, phoneError, PHONE_INPUT_MAX } from "@/lib/phone";
import { directTeamOf, isProjectReviewable, projectsHrefForRole, stringArray, teamMemberSummary, type ProjectTeamMember } from "@/lib/project-approval";
import { assertTeamsExist, canEmployeeManageIntern, deleteIntern, deleteTeam, setProjectTeams, updateIntern, updateTeam } from "@/lib/interns-teams";
import { resyncProjectsForUser, syncProjectAssignments } from "@/lib/assignments";
import type { CollectionName } from "@/lib/types";

const collections: CollectionName[] = ["clients", "projects", "projectRequests", "tasks", "milestones", "workReports", "notifications", "auditLogs", "users", "interns", "teams"];
/**
 * Record types with an update anyone other than a Super Admin can make: a team member or intern moving
 * their own task along or revising their own report, a CTO reviewing one, an employee editing an intern
 * they took on, and marking a notification read.
 * Every handler checks the role and the record again; this list only decides which ones are reachable.
 */
const sharedUpdateCollections: CollectionName[] = ["tasks", "workReports", "notifications", "interns"];
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
  teamIds: z.array(z.string().min(1)).max(50).optional(),
  assignedCto: z.string().min(1).optional(),
}).refine((value) => value.status !== "completed" || value.progressPercentage === 100, {
  message: "Set progress to 100% before completing a project.",
  path: ["progressPercentage"],
});
const clientUpdateSchema = z.object({
  // A Super Admin can revisit an approval here, not only through the one-time review dialog.
  approvalStatus: z.enum(["pending", "approved", "rejected"]).optional(),
  approvalComments: z.string().trim().max(4000).optional(),
  clientName: z.string().trim().min(2).max(160).optional(),
  contactPerson: z.string().trim().max(120).optional(),
  projectName: z.string().trim().min(2).max(160).optional(),
  officialEmail: z.email().max(254).transform((value) => value.trim().toLowerCase()).optional(),
  // Same Indian-mobile rule as everywhere else, and stored as the ten digits however it was typed.
  contactNumber: z.string().trim().min(1).max(PHONE_INPUT_MAX)
    .superRefine((value, ctx) => {
      const message = phoneError(value);
      if (message) ctx.addIssue({ code: "custom", message });
    })
    .transform((value) => { const result = checkPhone(value); return result.ok ? result.phone : value; })
    .optional(),
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
const projectReviewSchema = z.object({
  operation: z.literal("review"),
  action: z.enum(["approve", "reject"]),
  assignedTeam: z.array(z.string().trim().min(1)).max(50).optional().default([]),
  teamIds: z.array(z.string().trim().min(1)).max(50).optional().default([]),
  assignedCto: z.string().trim().max(128).optional().default(""),
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
    if (user.role !== "super_admin" && user.role !== "cto" && user.role !== "team_member") throw new HttpError("You cannot review work reports.", 403);
    const input = await parseBody(request, reportReviewSchema);
    const project = await db.collection("projects").doc(String(current.projectId)).get();
    if (!project.exists || (user.role === "cto" && project.data()?.assignedCto !== user.uid)) throw new HttpError("This report is outside your project scope.", 403);
    // An employee reviews the interns they took on, or who share one of their teams — nobody else.
    if (user.role === "team_member" && !(await canEmployeeManageIntern(user.uid, String(current.employeeId ?? "")))) {
      throw new HttpError("You can only review work reports from interns you manage.", 403);
    }
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
    if (!isWorkspaceMember(user.role) || current.employeeId !== user.uid) throw new HttpError("You can revise only your own reports.", 403);
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
  if (isWorkspaceMember(user.role) && current.assigneeId !== user.uid) throw new HttpError("You can update only your assigned tasks.", 403);
  if (!isWorkspaceMember(user.role) && user.role !== "cto" && user.role !== "super_admin") throw new HttpError("You cannot update this task.", 403);
  const batch = db.batch();
  batch.update(ref, { status: input.status, ...(input.comment ? { latestComment: input.comment, latestCommentBy: user.uid, latestCommentAt: FieldValue.serverTimestamp() } : {}), updatedAt: FieldValue.serverTimestamp() });
  addAuditToBatch(batch, user, "task_updated", "tasks", id, { status: input.status });
  await batch.commit();
  return { id, status: input.status };
}

/**
 * Removes a task that was assigned by mistake. A task somebody has already reported work against is part
 * of that report's context, so it is kept and closed rather than deleted.
 */
async function deleteTask(id: string, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin" && user.role !== "cto" && user.role !== "team_member") {
    throw new HttpError("You cannot delete tasks.", 403);
  }
  const db = adminDb();
  const ref = db.collection("tasks").doc(id);
  const task = await ref.get();
  if (!task.exists) throw new HttpError("Task not found.", 404);
  const current = task.data()!;
  if (user.role === "team_member" && current.createdBy !== user.uid) {
    throw new HttpError("You can only delete tasks you assigned yourself.", 403);
  }
  if (user.role === "cto") {
    const project = await db.collection("projects").doc(String(current.projectId)).get();
    if (!project.exists || project.data()?.assignedCto !== user.uid) throw new HttpError("This task is outside your project scope.", 403);
  }
  const reports = await db.collection("workReports").where("taskId", "==", id).limit(1).get();
  if (!reports.empty) {
    throw new HttpError("Work has already been reported against this task, so it cannot be deleted. Mark it completed or blocked instead.", 409);
  }
  const batch = db.batch();
  batch.delete(ref);
  addAuditToBatch(batch, user, "task_deleted", "tasks", id, {
    projectId: String(current.projectId ?? ""),
    title: String(current.title ?? ""),
    assigneeId: String(current.assigneeId ?? ""),
  });
  await batch.commit();
  const assignee = String(current.assigneeId ?? "");
  if (assignee && assignee !== user.uid) {
    void createNotification(assignee, "Task removed", `${String(current.title ?? "A task")} is no longer assigned to you.`, "/workspace/tasks", "task_deleted").catch(() => undefined);
  }
  return { id, deleted: true };
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
  if (isProjectReviewable(currentData)) throw new HttpError("Review this project submission and assign a team before updating delivery details.", 409);
  const nextStartDate = input.startDate ?? String(currentData.startDate ?? "");
  const nextEndDate = input.expectedEndDate ?? String(currentData.expectedEndDate ?? "");
  if (nextStartDate && nextEndDate && nextEndDate < nextStartDate) throw new HttpError("Expected end date must be on or after the start date.", 400);
  if (user.role === "cto" && input.assignedCto !== undefined) throw new HttpError("Only a Super Admin can reassign a project to another CTO.", 403);
  if (input.assignedTeam) {
    // Only people newly added here must be active. Existing direct members stay even if their account changed since.
    const previousDirect = directTeamOf(currentData);
    const added = input.assignedTeam.filter((uid) => !previousDirect.includes(uid));
    const members = await Promise.all(added.map((uid) => db.collection("users").doc(uid).get()));
    if (members.some((member) => !member.exists || member.data()?.role !== "team_member" || member.data()?.accountStatus !== "active")) {
      throw new HttpError("Choose only active team members for this project.", 400);
    }
  }
  if (input.teamIds) await assertTeamsExist(input.teamIds);
  let assignedCtoName: string | undefined;
  if (input.assignedCto) {
    const cto = await db.collection("users").doc(input.assignedCto).get();
    if (!cto.exists || cto.data()?.role !== "cto" || cto.data()?.accountStatus !== "active") {
      throw new HttpError("Choose an active CTO for this project.", 400);
    }
    assignedCtoName = String(cto.data()?.displayName ?? "");
  }
  const changes = {
    status: input.status,
    ...(input.progressPercentage !== undefined ? { progressPercentage: input.progressPercentage } : {}),
    ...(input.contractPrice !== undefined ? { contractPrice: input.contractPrice } : {}),
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
    ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
    ...(input.expectedEndDate !== undefined ? { expectedEndDate: input.expectedEndDate } : {}),
    ...(input.durationMonths !== undefined ? { durationMonths: input.durationMonths } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    // People chosen one by one. The full assignedTeam, including team members, is recomputed after this write.
    ...(input.assignedTeam !== undefined ? { directAssignedTeam: input.assignedTeam } : {}),
    ...(input.assignedCto !== undefined ? { assignedCto: input.assignedCto, assignedCtoName } : {}),
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
    ...(input.teamIds !== undefined ? { teamIds: input.teamIds } : {}),
    ...(input.assignedCto !== undefined ? { assignedCto: input.assignedCto } : {}),
  });
  await batch.commit();
  if (input.teamIds !== undefined) await setProjectTeams(id, input.teamIds);
  // Recomputes membership from direct people plus linked teams and notifies anyone who joined or left.
  if (input.assignedTeam !== undefined || input.teamIds !== undefined) await syncProjectAssignments([id]);
  const assignedProductManager = String(currentData.assignedProductManager ?? "");
  if (assignedProductManager && (input.status !== currentData.status || input.progressPercentage !== undefined)) {
    void createNotification(assignedProductManager, "Project update", `${String(currentData.name ?? "A project")} status: ${input.status.replaceAll("_", " ")}${input.progressPercentage === undefined ? "" : ` · ${input.progressPercentage}% complete`}.`, "/product-manager/updates", "project_updated").catch(() => undefined);
  }
  if (input.assignedCto && input.assignedCto !== current.data()?.assignedCto) {
    void createNotification(input.assignedCto, "Project assigned", `${String(currentData.name ?? "A project")} is now assigned to you.`, "/cto/projects", "project_assigned").catch(() => undefined);
  }
  return { id, status: input.status, progressPercentage: input.progressPercentage, assignedTeam: input.assignedTeam, assignedCto: input.assignedCto };
}

async function reviewProject(id: string, request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin") throw new HttpError("Only a Super Admin can review project submissions.", 403);
  const input = await parseBody(request, projectReviewSchema);
  const db = adminDb();
  const ref = db.collection("projects").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError("Project not found.", 404);
  const current = snapshot.data()!;
  if (!isProjectReviewable(current)) throw new HttpError("This project is no longer awaiting approval.", 409);

  const approve = input.action === "approve";
  const assignedTeam = [...new Set(input.assignedTeam)];
  const teamIds = approve ? [...new Set(input.teamIds)] : [];
  let assignedTeamMembers: ProjectTeamMember[] = [];
  let teamNames: string[] = [];
  let assignedCto = String(current.assignedCto ?? "");
  let assignedCtoName = String(current.assignedCtoName ?? "");
  if (approve) {
    if (!assignedTeam.length && !teamIds.length) throw new HttpError("Assign at least one team or team member before approving this project.", 400);
    teamNames = (await assertTeamsExist(teamIds)).map((team) => String(team.data()?.name ?? "Team"));
    const members = await Promise.all(assignedTeam.map((uid) => db.collection("users").doc(uid).get()));
    if (members.some((member) => !member.exists || member.data()?.role !== "team_member" || member.data()?.accountStatus !== "active")) {
      throw new HttpError("Only active team members can be assigned to a project.", 400);
    }
    assignedTeamMembers = members.map((member) => teamMemberSummary(member.id, member.data()));
    if (input.assignedCto) {
      const cto = await db.collection("users").doc(input.assignedCto).get();
      if (!cto.exists || cto.data()?.role !== "cto" || cto.data()?.accountStatus !== "active") throw new HttpError("Choose an active CTO for this project.", 400);
      assignedCto = input.assignedCto;
      assignedCtoName = String(cto.data()?.displayName ?? "");
    }
  } else if (!input.reviewerComments) {
    throw new HttpError("Add a comment so the submitter knows why the project was not approved.", 400);
  }

  const changes = approve
    ? {
      approvalStatus: "approved",
      status: "planning",
      assignedTeam,
      directAssignedTeam: assignedTeam,
      assignedTeamMembers,
      assignedCto,
      assignedCtoName,
      approvalComments: input.reviewerComments,
      reviewedBy: user.uid,
      reviewedByName: user.displayName,
      reviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }
    : {
      approvalStatus: "rejected",
      status: "rejected",
      approvalComments: input.reviewerComments,
      reviewedBy: user.uid,
      reviewedByName: user.displayName,
      reviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
  const auditRef = db.collection("auditLogs").doc();
  await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(ref);
    if (!latest.exists) throw new HttpError("Project not found.", 404);
    if (!isProjectReviewable(latest.data()!)) throw new HttpError("This project is no longer awaiting approval.", 409);
    transaction.update(ref, changes);
    transaction.set(auditRef, auditEntry(user, approve ? "project_approved" : "project_rejected", "projects", id, {
      name: String(current.name ?? ""),
      ...(approve ? { assignedTeam, teamIds, assignedCto } : {}),
      ...(input.reviewerComments ? { reviewerComments: input.reviewerComments } : {}),
    }));
  });

  if (approve) {
    // Linking teams adds their members through the shared recompute, which also brings in any intern
    // already assigned to this project and notifies everyone who joined.
    if (teamIds.length) await setProjectTeams(id, teamIds);
    await syncProjectAssignments([id]);
  }

  const projectName = String(current.name ?? "Your project");
  const creator = String(current.createdBy ?? "");
  if (creator && creator !== user.uid) {
    const creatorRole = current.createdByRole ? String(current.createdByRole) : (await db.collection("users").doc(creator).get()).data()?.role;
    const assignedSummary = [...teamNames.map((name) => `${name} team`), ...assignedTeamMembers.map((member) => member.displayName)].join(", ");
    void createNotification(
      creator,
      approve ? "Project approved" : "Project not approved",
      approve
        ? `${projectName} was approved by ${user.displayName}. Assigned: ${assignedSummary}.`
        : `${projectName} was not approved. ${input.reviewerComments}`,
      projectsHrefForRole(creatorRole),
      approve ? "project_approved" : "project_rejected",
    ).catch(() => undefined);
  }
  if (approve) {
    for (const uid of assignedTeam) {
      void createNotification(uid, "New project assignment", `You have been assigned to ${projectName}.`, "/workspace/projects", "project_assignment").catch(() => undefined);
    }
    if (assignedCto && assignedCto !== creator) {
      void createNotification(assignedCto, "Project assigned", `${projectName} is now assigned to you.`, "/cto/projects", "project_assigned").catch(() => undefined);
    }
  }
  return { id, ...changes, reviewedAt: null, updatedAt: null };
}

/** Linked records read in one pass when a project is deleted. Past this, deleting would need several batches. */
const PROJECT_CLEANUP_LIMIT = 200;

/**
 * Deletes a project together with the planning records that only exist to describe it, and unlinks it
 * from the teams, interns, and project request that point at it.
 *
 * Submitted work reports are people's own record of what they did, so a project that has any is refused
 * rather than quietly taking them down with it. Archiving is the way to retire that kind of project.
 */
async function deleteProject(id: string, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin") throw new HttpError("Only a Super Admin can delete a project.", 403);
  const db = adminDb();
  const ref = db.collection("projects").doc(id);
  const [project, reports, tasks, milestones, teams, interns, requests] = await Promise.all([
    ref.get(),
    db.collection("workReports").where("projectId", "==", id).limit(1).get(),
    db.collection("tasks").where("projectId", "==", id).limit(PROJECT_CLEANUP_LIMIT + 1).get(),
    db.collection("milestones").where("projectId", "==", id).limit(PROJECT_CLEANUP_LIMIT + 1).get(),
    db.collection("teams").where("projectIds", "array-contains", id).get(),
    db.collection("interns").where("projectIds", "array-contains", id).get(),
    db.collection("projectRequests").where("projectId", "==", id).get(),
  ]);
  if (!project.exists) throw new HttpError("Project not found.", 404);
  const current = project.data()!;
  if (!reports.empty) {
    throw new HttpError("Work reports have been submitted for this project, so deleting it would take that history with it. Set its status to cancelled or archived instead.", 409);
  }
  if (tasks.size > PROJECT_CLEANUP_LIMIT || milestones.size > PROJECT_CLEANUP_LIMIT) {
    throw new HttpError("This project has too many tasks or milestones to delete in one step. Set its status to archived instead.", 409);
  }
  const batch = db.batch();
  for (const task of tasks.docs) batch.delete(task.ref);
  for (const milestone of milestones.docs) batch.delete(milestone.ref);
  for (const team of teams.docs) batch.update(team.ref, { projectIds: FieldValue.arrayRemove(id), updatedAt: FieldValue.serverTimestamp() });
  for (const intern of interns.docs) batch.update(intern.ref, { projectIds: FieldValue.arrayRemove(id), updatedAt: FieldValue.serverTimestamp() });
  // An approved request becomes convertible again rather than pointing at a project that is gone.
  for (const linked of requests.docs) batch.update(linked.ref, { projectId: FieldValue.delete(), convertedAt: null, updatedAt: FieldValue.serverTimestamp() });
  batch.delete(ref);
  addAuditToBatch(batch, user, "project_deleted", "projects", id, {
    name: String(current.name ?? ""),
    clientId: String(current.clientId ?? ""),
    deletedTasks: tasks.size,
    deletedMilestones: milestones.size,
    unlinkedTeams: teams.docs.map((team) => team.id),
    unlinkedInterns: interns.docs.map((intern) => intern.id),
  });
  await batch.commit();
  const name = String(current.name ?? "a project");
  for (const uid of stringArray(current.assignedTeam)) {
    void createNotification(uid, "Project removed", `${name} is no longer in the workspace.`, "/workspace/projects", "project_deleted").catch(() => undefined);
  }
  return { id, deleted: true };
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
  if (user.role !== "super_admin" && (input.approvalStatus !== undefined || input.approvalComments !== undefined)) {
    throw new HttpError("Only a Super Admin can change a client's approval.", 403);
  }
  if (input.approvalStatus === "rejected" && !(input.approvalComments ?? String(current.data()?.approvalComments ?? "")).trim()) {
    throw new HttpError("Add a review note so the submitter knows why this client was not approved.", 400);
  }
  if (input.assignedProductManager) {
    const manager = await db.collection("users").doc(input.assignedProductManager).get();
    if (!manager.exists || manager.data()?.role !== "product_manager" || manager.data()?.accountStatus !== "active") {
      throw new HttpError("Choose an active Product Manager for this client.", 400);
    }
  }
  const changes = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  // A change of approval is a review, so it is stamped like one. A client that is no longer approved
  // cannot stay active, because an active client is what projects are allowed to be raised against.
  const reviewed = input.approvalStatus !== undefined && input.approvalStatus !== current.data()?.approvalStatus;
  const update = {
    ...changes,
    ...(input.officialEmail ? { officialEmailNormalized: input.officialEmail } : {}),
    ...(reviewed ? { reviewedBy: user.uid, reviewedAt: FieldValue.serverTimestamp() } : {}),
    ...(input.approvalStatus && input.approvalStatus !== "approved" ? { status: "draft" } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const batch = db.batch();
  batch.update(ref, update);
  addAuditToBatch(batch, user, reviewed ? `client_${input.approvalStatus}` : "client_updated", "clients", id, { changedFields: Object.keys(changes) });
  await batch.commit();
  return { id, ...changes };
}

async function deleteClient(id: string, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin") throw new HttpError("Only a Super Admin can delete client records.", 403);
  const db = adminDb();
  const ref = db.collection("clients").doc(id);
  const auditRef = db.collection("auditLogs").doc();
  await db.runTransaction(async (transaction) => {
    const [client, projects, requests] = await Promise.all([
      transaction.get(ref),
      transaction.get(db.collection("projects").where("clientId", "==", id).limit(1)),
      transaction.get(db.collection("projectRequests").where("clientId", "==", id).limit(1)),
    ]);
    if (!client.exists) throw new HttpError("Client not found.", 404);
    if (!projects.empty || !requests.empty) {
      throw new HttpError("This client is linked to a project or project request. Remove those links before deleting the client.", 409);
    }
    transaction.delete(ref);
    transaction.set(auditRef, auditEntry(user, "client_deleted", "clients", id, {
      clientName: String(client.data()?.clientName ?? ""),
      companyName: String(client.data()?.companyName ?? ""),
    }));
  });
  return { id, deleted: true };
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
  // An intern sign-in follows their intern record, so its role and access are managed from the Interns page.
  // An intern's role comes from their intern record, so only their access can be changed from here.
  if (current.role === "intern" && input.operation === "change_role") {
    throw new HttpError("An intern's role follows their intern record. Change it from the Interns page.", 409);
  }
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
  // Team-based project access depends on being an active team member, so refresh this person's projects.
  if (nextRole !== current.role || nextStatus !== current.accountStatus) await resyncProjectsForUser(id);
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

/**
 * Refuses to delete an account that still leads work, because the records pointing at it would be left
 * with an owner who no longer exists. The Super Admin reassigns that work first.
 */
async function assertNothingDependsOnUser(uid: string, role: string) {
  const db = adminDb();
  if (role === "cto") {
    const projects = await db.collection("projects").where("assignedCto", "==", uid).limit(1).get();
    if (!projects.empty) throw new HttpError("This CTO still leads at least one project. Reassign those projects before deleting the account.", 409);
  }
  if (role === "product_manager") {
    const [projects, clients] = await Promise.all([
      db.collection("projects").where("assignedProductManager", "==", uid).limit(1).get(),
      db.collection("clients").where("assignedProductManager", "==", uid).limit(1).get(),
    ]);
    if (!projects.empty || !clients.empty) {
      throw new HttpError("This Product Manager is still assigned to a client or project. Reassign those records before deleting the account.", 409);
    }
  }
}

async function deleteWorkspaceUser(id: string, request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin") throw new HttpError("Only a Super Admin can delete accounts.", 403);
  if (id === user.uid) throw new HttpError("You cannot delete your own account.", 403);
  const input = await parseBody(request, userDeleteSchema);
  const db = adminDb();
  const profileRef = db.collection("users").doc(id);
  const initialProfile = await profileRef.get();
  if (!initialProfile.exists) throw new HttpError("User not found.", 404);
  const role = String(initialProfile.data()?.role ?? "");
  // A Super Admin account has to be demoted on purpose first, so the workspace is never left without one.
  if (role === "super_admin") throw new HttpError("Change this account's role before deleting it, so the workspace is never left without a Super Admin.", 409);

  // Checked before the password, so a blocked delete does not spend one of the hour's five attempts.
  await assertNothingDependsOnUser(id, role);
  await verifySuperAdminPassword(input.password, user);

  const existingStatus = String(initialProfile.data()?.accountStatus ?? "active");
  const wasAlreadyPending = Boolean(initialProfile.data()?.deletionPending);
  if (wasAlreadyPending && existingStatus !== "suspended") {
    throw new HttpError("This account has an invalid deletion state. Contact support.", 409);
  }
  await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(profileRef);
    if (!latest.exists) throw new HttpError("User not found.", 404);
    if (latest.data()?.role !== role) throw new HttpError("This account's role changed while it was being deleted. Refresh and try again.", 409);
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
      throw new HttpError("The account could not be deleted. Try again.", 503);
    }
  }

  const retiredIdRef = db.collection("deletedUserIds").doc(id);
  const auditRef = db.collection("auditLogs").doc();
  // Deleting an intern's account only takes away their sign-in. The intern record stays on the Interns
  // page, without a login, and a new password there gives them a fresh one.
  const internRecord = role === "intern"
    ? (await db.collection("interns").where("loginUid", "==", id).limit(1).get()).docs[0]
    : undefined;
  await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(profileRef);
    if (!latest.exists) throw new HttpError("User not found.", 404);
    if (latest.data()?.role !== role || !latest.data()?.deletionPending) {
      throw new HttpError("The account changed while it was being deleted. Refresh and try again.", 409);
    }
    if (internRecord) transaction.update(internRecord.ref, { loginUid: "", updatedAt: FieldValue.serverTimestamp() });
    transaction.delete(profileRef);
    transaction.set(retiredIdRef, {
      deletedAt: FieldValue.serverTimestamp(),
      deletedBy: user.uid,
    });
    transaction.set(auditRef, auditEntry(user, "user_deleted", "users", id, {
      role,
      displayName: String(latest.data()?.displayName ?? ""),
      email: String(latest.data()?.email ?? ""),
      ...(internRecord ? { internId: internRecord.id, internRecordKept: true } : {}),
    }));
  });
  // Take the deleted account out of its teams and refresh every project it was on.
  await resyncProjectsForUser(id, { removeFromTeams: true });
  return { id, deleted: true };
}

export async function PATCH(request: Request, context: { params: Promise<{ collection: string; id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireSessionUser();
    const { collection: rawCollection, id } = await context.params;
    const collection = ensureCollection(rawCollection);
    if (user.role !== "super_admin" && !sharedUpdateCollections.includes(collection)) {
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
    else if (collection === "tasks") {
      const operation = (await parseBody(request.clone(), z.object({ operation: z.string().optional() }))).operation;
      result = operation === "delete" ? await deleteTask(id, user) : await updateTask(id, request, user);
    }
    else if (collection === "projects") {
      const operation = (await parseBody(request.clone(), z.object({ operation: z.string().optional() }))).operation;
      result = operation === "review" ? await reviewProject(id, request, user)
        : operation === "delete" ? await deleteProject(id, user)
          : await updateProject(id, request, user);
    }
    else if (collection === "milestones") result = await updateMilestone(id, request, user);
    else if (collection === "interns" || collection === "teams") {
      const operation = (await parseBody(request.clone(), z.object({ operation: z.string().optional() }))).operation;
      if (collection === "interns") result = operation === "delete" ? await deleteIntern(id, user) : await updateIntern(id, request, user);
      else result = operation === "delete" ? await deleteTeam(id, user) : await updateTeam(id, request, user);
    }
    else if (collection === "clients") {
      const operation = (await parseBody(request.clone(), z.object({ operation: z.string().optional() }))).operation;
      result = operation === "review" ? await reviewClient(id, request, user)
        : operation === "delete" ? await deleteClient(id, user)
          : await updateClient(id, request, user);
    }
    else if (collection === "users") {
      const operation = (await parseBody(request.clone(), z.object({ operation: z.string().optional() }))).operation;
      result = operation === "delete" ? await deleteWorkspaceUser(id, request, user) : await updateUser(id, request, user);
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
