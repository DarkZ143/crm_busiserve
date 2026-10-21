import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { requireSessionUser } from "@/lib/auth";
import { canReadCollection, isWorkspaceMember } from "@/lib/access-control";
import { addAuditToBatch, auditEntry, createNotification, listRecords, notifyRole } from "@/lib/data";
import { redactRecordForRole } from "@/lib/record-security";
import { canReadRecord } from "@/lib/access-control";
import { stringArray, teamMemberSummary } from "@/lib/project-approval";
import { addInternToProject, assertTeamsExist, createIntern, createTeam, setProjectTeams } from "@/lib/interns-teams";
import { syncProjectAssignments } from "@/lib/assignments";
import { assertSameOrigin, errorResponse, HttpError, parseBody, serializeRecord } from "@/lib/http";
import { checkPhone, phoneError, PHONE_INPUT_MAX } from "@/lib/phone";
import type { CollectionName } from "@/lib/types";

/** A client's contact number follows the same Indian-mobile rule as every other number here. */
const contactNumberSchema = z.string().trim().min(1, "A contact number is required.").max(PHONE_INPUT_MAX)
  .superRefine((value, ctx) => {
    const message = phoneError(value);
    if (message) ctx.addIssue({ code: "custom", message });
  })
  // Stored as the ten digits, however the person typed them.
  .transform((value) => { const result = checkPhone(value); return result.ok ? result.phone : value; });

const collectionNames: CollectionName[] = ["clients", "projects", "projectRequests", "tasks", "milestones", "workReports", "notifications", "auditLogs", "users", "interns", "teams"];
const roles = ["super_admin", "cto", "product_manager", "team_member"] as const;

const clientSchema = z.object({
  // Required: client name, contact number, project name, and business address. Everything else is optional.
  clientName: z.string().trim().min(2).max(160),
  contactNumber: contactNumberSchema,
  projectName: z.string().trim().min(2).max(160),
  businessAddress: z.string().trim().min(3).max(500),
  contactPerson: z.string().trim().max(120).optional().default(""),
  officialEmail: z.preprocess(
    (value) => typeof value === "string" && !value.trim() ? undefined : value,
    z.email().max(254).transform((value) => value.trim().toLowerCase()).optional(),
  ).transform((value) => value ?? ""),
  companyName: z.string().trim().max(160).optional().default(""),
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
  teamIds: idList.optional().default([]),
}).refine((record) => !record.startDate || !record.expectedEndDate || record.expectedEndDate >= record.startDate, {
  message: "Expected end date must be after the start date.",
  path: ["expectedEndDate"],
});

// What a non-admin can define when proposing a project. Team, CTO, and commercial terms are set by the Super Admin on review.
const projectSubmissionSchema = z.object({
  clientId: z.string().trim().max(128).optional().default(""),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(5000).optional().default(""),
  category: z.string().trim().max(100).optional().default(""),
  scopeOfWork: z.string().trim().max(8000).optional().default(""),
  requirements: z.string().trim().max(8000).optional().default(""),
  deliverables: z.string().trim().max(5000).optional().default(""),
  startDate: z.string().date().optional(),
  expectedEndDate: z.string().date().optional(),
  durationMonths: z.coerce.number().int().min(1).max(120).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional().default("normal"),
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
  uid: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, dashes, and underscores for the user ID.").optional(),
  displayName: z.string().trim().min(2).max(100),
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  password: z.string().min(12).max(128),
  role: z.enum(roles),
  designation: z.string().trim().max(100).optional().default(""),
});

function ensureCollection(value: string): CollectionName {
  if (!collectionNames.includes(value as CollectionName)) throw new HttpError("Record type not found.", 404);
  return value as CollectionName;
}

async function createClient(request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  const input = await parseBody(request, clientSchema);
  const db = adminDb();
  const assignedProductManager = user.role === "super_admin"
    ? input.assignedProductManager ?? ""
    : user.role === "product_manager" ? user.uid : "";
  const manager = assignedProductManager ? await db.collection("users").doc(assignedProductManager).get() : null;
  if (assignedProductManager && (!manager?.exists || manager.data()?.role !== "product_manager" || manager.data()?.accountStatus !== "active")) {
    throw new HttpError("Choose an active Product Manager for this client.", 400);
  }
  const approved = user.role === "super_admin";
  const ref = db.collection("clients").doc();
  const auditRef = db.collection("auditLogs").doc();
  const record = {
    ...input,
    internalNotes: user.role === "super_admin" ? input.internalNotes : "",
    id: ref.id,
    clientId: `CLI-${ref.id.slice(0, 8).toUpperCase()}`,
    officialEmailNormalized: input.officialEmail,
    assignedProductManager,
    approvalStatus: approved ? "approved" : "pending",
    approvalComments: "",
    reviewedBy: approved ? user.uid : null,
    reviewedAt: approved ? FieldValue.serverTimestamp() : null,
    status: approved ? input.status : "draft",
    createdBy: user.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db.runTransaction(async (transaction) => {
    // Email is optional, so only check for duplicates when one was given.
    if (input.officialEmail) {
      const duplicate = await transaction.get(db.collection("clients").where("officialEmailNormalized", "==", input.officialEmail).limit(1));
      if (!duplicate.empty) throw new HttpError("A client already exists with this email address.", 409);
    }
    transaction.set(ref, record);
    transaction.set(auditRef, auditEntry(user, approved ? "client_created" : "client_submitted_for_approval", "clients", ref.id, { clientName: input.clientName }));
  });
  if (!approved) {
    void notifyRole("super_admin", "Client approval needed", `${input.clientName} was submitted by ${user.displayName}.`, "/admin/clients", "client_submitted").catch(() => undefined);
  }
  return redactRecordForRole("clients", { ...record, id: ref.id, clientId: `CLI-${ref.id.slice(0, 8).toUpperCase()}` }, user.role);
}

function isClientApproved(client: FirebaseFirestore.DocumentData) {
  return client.approvalStatus === undefined ? client.status !== "draft" : client.approvalStatus === "approved";
}

async function createProjectRequest(request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin" && user.role !== "product_manager") throw new HttpError("Only a Product Manager can submit a project request.", 403);
  const input = await parseBody(request, projectRequestSchema);
  const db = adminDb();
  const client = await db.collection("clients").doc(input.clientId).get();
  if (!client.exists) throw new HttpError("The selected client was not found.", 404);
  if (!isClientApproved(client.data()!)) throw new HttpError("This client is awaiting Super Admin approval.", 409);
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
  const { teamIds, ...input } = await parseBody(request, projectSchema);
  const db = adminDb();
  const [client, members] = await Promise.all([
    db.collection("clients").doc(input.clientId).get(),
    Promise.all(input.assignedTeam.map((uid) => db.collection("users").doc(uid).get())),
  ]);
  if (!client.exists) throw new HttpError("The selected client was not found.", 404);
  if (!isClientApproved(client.data()!)) throw new HttpError("This client is awaiting Super Admin approval.", 409);
  if (members.some((member) => !member.exists || member.data()?.role !== "team_member" || member.data()?.accountStatus !== "active")) {
    throw new HttpError("Only active team members can be assigned to a project.", 400);
  }
  const assignedCto = user.role === "cto" ? user.uid : input.assignedCto;
  if (user.role === "super_admin" && !assignedCto) throw new HttpError("Choose an active CTO for this project.", 400);
  if (user.role === "super_admin" && assignedCto) {
    const cto = await db.collection("users").doc(assignedCto).get();
    if (!cto.exists || cto.data()?.role !== "cto" || cto.data()?.accountStatus !== "active") throw new HttpError("Choose an active CTO.", 400);
  }
  await assertTeamsExist(teamIds);
  const ref = db.collection("projects").doc();
  const assignedCtoName = assignedCto === user.uid ? user.displayName : assignedCto ? String((await db.collection("users").doc(assignedCto).get()).data()?.displayName ?? "") : "";
  const record = {
    ...input,
    id: ref.id,
    projectId: `PRJ-${ref.id.slice(0, 8).toUpperCase()}`,
    clientName: String(client.data()?.clientName ?? ""),
    assignedCto,
    assignedCtoName,
    assignedProductManager: client.data()?.assignedProductManager ?? "",
    assignedTeam: input.assignedTeam,
    directAssignedTeam: input.assignedTeam,
    assignedTeamMembers: members.map((member) => teamMemberSummary(member.id, member.data())),
    assignedTeams: [] as { id: string; name: string }[],
    assignedInterns: [] as { id: string; internId: string; fullName: string; role: string }[],
    approvalStatus: "approved",
    approvalComments: "",
    reviewedBy: user.uid,
    reviewedByName: user.displayName,
    reviewedAt: FieldValue.serverTimestamp(),
    createdBy: user.uid,
    createdByName: user.displayName,
    createdByRole: user.role,
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
  if (teamIds.length) {
    // Team members join through the shared recompute, which also notifies them.
    await setProjectTeams(ref.id, teamIds);
    await syncProjectAssignments([ref.id]);
  }
  return redactRecordForRole("projects", { id: ref.id, ...input, assignedCto, assignedTeam: input.assignedTeam, progressPercentage: 0 }, user.role);
}

async function submitProject(request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role === "super_admin") throw new HttpError("Super Admins create projects directly.", 400);
  const input = await parseBody(request, projectSubmissionSchema);
  const db = adminDb();
  let clientName = "";
  let assignedProductManager = user.role === "product_manager" ? user.uid : "";
  if (input.clientId) {
    const client = await db.collection("clients").doc(input.clientId).get();
    if (!client.exists || !canReadRecord(user.role, user.uid, "clients", client.data()!)) throw new HttpError("The selected client was not found.", 404);
    if (!isClientApproved(client.data()!)) throw new HttpError("This client is awaiting Super Admin approval.", 409);
    clientName = String(client.data()?.clientName ?? "");
    // The client's Product Manager (chosen by the Super Admin) owns projects for that client.
    assignedProductManager = String(client.data()?.assignedProductManager ?? "") || assignedProductManager;
  }
  const ref = db.collection("projects").doc();
  const record = {
    ...input,
    id: ref.id,
    projectId: `PRJ-${ref.id.slice(0, 8).toUpperCase()}`,
    clientName,
    status: "pending_approval",
    approvalStatus: "pending",
    approvalComments: "",
    reviewedBy: null,
    reviewedByName: "",
    reviewedAt: null,
    // A CTO who proposes a project is suggested as its lead; the Super Admin can change this on review.
    assignedCto: user.role === "cto" ? user.uid : "",
    assignedCtoName: user.role === "cto" ? user.displayName : "",
    assignedProductManager,
    assignedTeam: [] as string[],
    assignedTeamMembers: [] as ReturnType<typeof teamMemberSummary>[],
    createdBy: user.uid,
    createdByName: user.displayName,
    createdByRole: user.role,
    progressPercentage: 0,
    actualCompletionDate: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const batch = db.batch();
  batch.set(ref, record);
  addAuditToBatch(batch, user, "project_submitted_for_approval", "projects", ref.id, { name: input.name, clientId: input.clientId });
  await batch.commit();
  void notifyRole("super_admin", "Project approval needed", `${input.name} was submitted by ${user.displayName}. Review it and assign a team.`, "/admin/projects", "project_submitted").catch(() => undefined);
  return redactRecordForRole("projects", { ...record, createdAt: null, updatedAt: null }, user.role);
}

async function createTask(request: Request, user: Awaited<ReturnType<typeof requireSessionUser>>) {
  if (user.role !== "super_admin" && user.role !== "cto" && user.role !== "team_member") {
    throw new HttpError("You cannot assign tasks.", 403);
  }
  const input = await parseBody(request, taskSchema);
  const db = adminDb();
  const [project, assignee] = await Promise.all([
    db.collection("projects").doc(input.projectId).get(),
    db.collection("users").doc(input.assigneeId).get(),
  ]);
  if (!project.exists || (user.role === "cto" && project.data()?.assignedCto !== user.uid)) throw new HttpError("The selected project is unavailable.", 404);
  const assignedTeam = stringArray(project.data()?.assignedTeam);
  if (user.role === "team_member" && !assignedTeam.includes(user.uid)) {
    throw new HttpError("You can only assign tasks on projects you are working on yourself.", 403);
  }
  // Interns can be given tasks too, through the sign-in created with their intern record.
  if (!assignee.exists || !isWorkspaceMember(String(assignee.data()?.role)) || assignee.data()?.accountStatus !== "active") {
    throw new HttpError("Assign tasks to an active team member or intern.", 400);
  }
  if (!assignedTeam.includes(input.assigneeId)) {
    // An intern chosen from the full list joins the project as part of being given work on it.
    // Everyone else has to be put on the project first, which is a separate decision.
    if (assignee.data()?.role !== "intern") throw new HttpError("Assign tasks to someone already on this project team.", 400);
    await addInternToProject(input.assigneeId, input.projectId);
  }
  const ref = db.collection("tasks").doc();
  const batch = db.batch();
  batch.set(ref, { ...input, id: ref.id, status: "open", assigneeName: assignee.data()?.displayName ?? "", createdBy: user.uid, createdByName: user.displayName, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
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
  if (!isWorkspaceMember(user.role)) throw new HttpError("Only team members and interns can submit work reports.", 403);
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
  if (input.uid && (await Promise.all([
    db.collection("users").doc(input.uid).get(),
    db.collection("deletedUserIds").doc(input.uid).get(),
  ])).some((snapshot) => snapshot.exists)) {
    throw new HttpError("That user ID is already in use.", 409);
  }
  let authUser;
  try {
    authUser = await adminAuth().createUser({
      ...(input.uid ? { uid: input.uid } : {}),
      email: input.email,
      displayName: input.displayName,
      password: input.password,
      disabled: false,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "auth/email-already-exists") throw new HttpError("An account already exists for this email.", 409);
      if (error.code === "auth/uid-already-exists") throw new HttpError("That user ID is already in use.", 409);
    }
    throw error;
  }
  try {
    await adminAuth().setCustomUserClaims(authUser.uid, { role: input.role });
    const profileRef = db.collection("users").doc(authUser.uid);
    const retiredIdRef = db.collection("deletedUserIds").doc(authUser.uid);
    const auditRef = db.collection("auditLogs").doc();
    await db.runTransaction(async (transaction) => {
      const [profile, retiredId] = await Promise.all([
        transaction.get(profileRef),
        transaction.get(retiredIdRef),
      ]);
      if (profile.exists || retiredId.exists) throw new HttpError("That user ID is already in use.", 409);
      transaction.set(profileRef, {
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
      transaction.set(auditRef, auditEntry(user, "user_created", "users", authUser.uid, { role: input.role, email: input.email }));
    });
  } catch (error) {
    await adminAuth().deleteUser(authUser.uid).catch(() => undefined);
    throw error;
  }
  return { id: authUser.uid, uid: authUser.uid, displayName: input.displayName, email: input.email, role: input.role };
}

export async function GET(_request: Request, context: { params: Promise<{ collection: string }> }) {
  try {
    const user = await requireSessionUser();
    const { collection: rawCollection } = await context.params;
    const collection = ensureCollection(rawCollection);
    if (!canReadCollection(user.role, collection)) {
      throw new HttpError("This record type is not available to your role.", 403);
    }
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
    const canCreate = user.role === "super_admin"
      || collection === "projects" && user.role !== "intern"
      || collection === "clients" && !isWorkspaceMember(user.role)
      || collection === "workReports" && isWorkspaceMember(user.role)
      // A full-time employee takes on interns and gives them work on their own projects.
      || collection === "interns" && user.role === "team_member"
      || collection === "tasks" && (user.role === "cto" || user.role === "team_member")
      || collection === "milestones" && user.role === "cto";
    if (!canCreate) {
      throw new HttpError("You cannot create this record type.", 403);
    }
    let record;
    if (collection === "clients") record = await createClient(request, user);
    else if (collection === "projectRequests") record = await createProjectRequest(request, user);
    else if (collection === "projects") record = user.role === "super_admin" ? await createProject(request, user) : await submitProject(request, user);
    else if (collection === "tasks") record = await createTask(request, user);
    else if (collection === "milestones") record = await createMilestone(request, user);
    else if (collection === "workReports") record = await createReport(request, user);
    else if (collection === "users") record = await inviteUser(request, user);
    else if (collection === "interns") record = await createIntern(request, user);
    else if (collection === "teams") record = await createTeam(request, user);
    else throw new HttpError("This record type cannot be created here.", 405);
    return NextResponse.json({ record: serializeRecord(record) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
