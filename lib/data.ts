import "server-only";

import { FieldPath, FieldValue, Filter, type Query, type WriteBatch } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { canReadRecord } from "@/lib/access-control";
import { redactRecordForRole } from "@/lib/record-security";
import type { CollectionName, RecordData, Role, SessionUser } from "@/lib/types";
import { serializeRecord } from "@/lib/http";

const QUERY_LIMIT = 100;

export async function getCompanyTimezone() {
  const settings = await adminDb().doc("companySettings/general").get();
  return String(settings.data()?.timezone ?? "Asia/Kolkata");
}

export function dateInTimezone(timeZone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date)
    .reduce((values, part) => ({ ...values, [part.type]: part.value }), {} as Record<string, string>);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function serializeSnapshot(snapshot: FirebaseFirestore.QueryDocumentSnapshot): RecordData {
  return serializeRecord({ id: snapshot.id, ...snapshot.data() }) as RecordData;
}

async function projectIdsFor(user: SessionUser) {
  const query = await scopedQuery("projects", user);
  const snapshot = await query.get();
  return snapshot.docs.map((project) => project.id);
}

async function scopedQuery(collection: CollectionName, user: SessionUser): Promise<Query> {
  const db = adminDb();
  const rows = db.collection(collection);

  if (collection === "clients") {
    if (user.role === "super_admin" || user.role === "cto") return rows;
    if (user.role === "product_manager") return rows.where(Filter.or(
      Filter.where("createdBy", "==", user.uid),
      Filter.where("assignedProductManager", "==", user.uid),
    ));
    return rows.where(FieldPath.documentId(), "==", "__no_access__");
  }
  if (collection === "projects") {
    if (user.role === "super_admin") return rows;
    if (user.role === "cto") return rows.where("assignedCto", "==", user.uid);
    if (user.role === "product_manager") return rows.where("assignedProductManager", "==", user.uid);
    return rows.where("assignedTeam", "array-contains", user.uid);
  }
  if (collection === "projectRequests") {
    if (user.role === "super_admin") return rows;
    if (user.role === "cto") return rows.where("status", "!=", "draft");
    if (user.role === "product_manager") return rows.where(Filter.or(
      Filter.where("createdBy", "==", user.uid),
      Filter.where("assignedProductManager", "==", user.uid),
    ));
    return rows.where(FieldPath.documentId(), "==", "__no_access__");
  }
  if (collection === "workReports") {
    if (user.role === "super_admin") return rows;
    if (user.role === "team_member") return rows.where("employeeId", "==", user.uid);
    const projectIds = await projectIdsFor(user);
    if (projectIds.length === 0) return rows.where(FieldPath.documentId(), "==", "__no_access__");
    return rows.where("projectId", "in", projectIds.slice(0, 30));
  }
  if (collection === "tasks") {
    if (user.role === "super_admin") return rows;
    if (user.role === "team_member") return rows.where("assigneeId", "==", user.uid);
    const projectIds = await projectIdsFor(user);
    if (projectIds.length === 0) return rows.where(FieldPath.documentId(), "==", "__no_access__");
    return rows.where("projectId", "in", projectIds.slice(0, 30));
  }
  if (collection === "milestones") {
    if (user.role === "super_admin") return rows;
    const projectIds = await projectIdsFor(user);
    if (projectIds.length === 0) return rows.where(FieldPath.documentId(), "==", "__no_access__");
    return rows.where("projectId", "in", projectIds.slice(0, 30));
  }
  if (collection === "notifications") return rows.where("recipientUid", "==", user.uid);
  if (collection === "auditLogs") {
    if (user.role === "super_admin") return rows;
    if (user.role === "cto") return rows.where("actorUid", "==", user.uid);
    return rows.where(FieldPath.documentId(), "==", "__no_access__");
  }
  if (collection === "users") {
    if (user.role === "super_admin") return rows;
    if (user.role === "cto") return rows.where("role", "==", "team_member");
    return rows.where(FieldPath.documentId(), "==", "__no_access__");
  }
  return rows.where(FieldPath.documentId(), "==", "__no_access__");
}

export async function listRecords(collection: CollectionName, user: SessionUser) {
  let documents: FirebaseFirestore.QueryDocumentSnapshot[];
  let scopedProjectIds: ReadonlySet<string> | undefined;
  const managerScopedTasks = (collection === "tasks" || collection === "workReports") && (user.role === "cto" || user.role === "product_manager");
  const teamScopedTasks = collection === "tasks" && user.role === "team_member";
  const projectScopedMilestones = collection === "milestones" && (user.role === "cto" || user.role === "product_manager" || user.role === "team_member");
  if (managerScopedTasks || teamScopedTasks || projectScopedMilestones) {
    const projectIds = await projectIdsFor(user);
    scopedProjectIds = new Set(projectIds);
    const chunks = Array.from({ length: Math.ceil(projectIds.length / 30) }, (_, index) => projectIds.slice(index * 30, index * 30 + 30));
    const snapshots = await Promise.all(chunks.map((ids) => {
      let query = adminDb().collection(collection).where("projectId", "in", ids);
      if (teamScopedTasks) query = query.where("assigneeId", "==", user.uid);
      return query.limit(QUERY_LIMIT).get();
    }));
    documents = snapshots.flatMap((snapshot) => snapshot.docs).slice(0, QUERY_LIMIT);
  } else {
    const query = await scopedQuery(collection, user);
    const snapshot = await query.limit(QUERY_LIMIT).get();
    documents = snapshot.docs;
  }
  const records = documents
    .map(serializeSnapshot)
    .filter((record) => canReadRecord(user.role, user.uid, collection, record, scopedProjectIds));
  const redacted = records.map((record) => redactRecordForRole(collection, record, user.role));
  return redacted.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

export async function getRecord(collection: CollectionName, id: string) {
  const snapshot = await adminDb().collection(collection).doc(id).get();
  if (!snapshot.exists) return null;
  return serializeRecord({ id: snapshot.id, ...snapshot.data() }) as RecordData;
}

export async function writeAudit(
  actor: SessionUser,
  action: string,
  targetCollection: string,
  targetId: string,
  changes?: Record<string, unknown>,
) {
  await adminDb().collection("auditLogs").add({
    actorUid: actor.uid,
    actorName: actor.displayName,
    actorRole: actor.role,
    action,
    targetCollection,
    targetId,
    ...(changes ? { changes } : {}),
    createdAt: FieldValue.serverTimestamp(),
  });
}

export function auditEntry(
  actor: SessionUser,
  action: string,
  targetCollection: string,
  targetId: string,
  changes?: Record<string, unknown>,
) {
  return {
    actorUid: actor.uid,
    actorName: actor.displayName,
    actorRole: actor.role,
    action,
    targetCollection,
    targetId,
    ...(changes ? { changes } : {}),
    createdAt: FieldValue.serverTimestamp(),
  };
}

export function addAuditToBatch(
  batch: WriteBatch,
  actor: SessionUser,
  action: string,
  targetCollection: string,
  targetId: string,
  changes?: Record<string, unknown>,
) {
  const ref = adminDb().collection("auditLogs").doc();
  batch.set(ref, auditEntry(actor, action, targetCollection, targetId, changes));
}

export async function createNotification(
  recipientUid: string,
  title: string,
  body: string,
  href: string,
  kind: string,
) {
  await adminDb().collection("notifications").add({
    recipientUid,
    title,
    body,
    href,
    kind,
    readAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });
}

export async function notifyRole(role: Role, title: string, body: string, href: string, kind: string) {
  const recipients = await adminDb().collection("users")
    .where("role", "==", role)
    .where("accountStatus", "==", "active")
    .limit(100)
    .get();
  await Promise.all(recipients.docs.map((doc) => createNotification(doc.id, title, body, href, kind)));
}

export async function getDashboardRecords(user: SessionUser) {
  const timezone = await getCompanyTimezone();
  const workDate = dateInTimezone(timezone);
  const groups = await Promise.all([
    listRecords("clients", user),
    listRecords("projects", user),
    listRecords("projectRequests", user),
    listRecords("tasks", user),
    listRecords("workReports", user),
    listRecords("notifications", user),
    user.role === "super_admin" ? listRecords("auditLogs", user) : Promise.resolve([]),
    user.role === "super_admin" || user.role === "cto" ? listRecords("users", user) : Promise.resolve([]),
    getDashboardTotals(user, workDate),
  ]);
  return {
    clients: groups[0],
    projects: groups[1],
    projectRequests: groups[2],
    tasks: groups[3],
    workReports: groups[4],
    notifications: groups[5],
    auditLogs: groups[6],
    users: groups[7],
    timezone,
    totals: groups[8],
  };
}

async function aggregateCount(query: Query) {
  const snapshot = await query.count().get();
  return snapshot.data().count;
}

async function scopedProjectCount(collection: "tasks" | "workReports", user: SessionUser, filters: (query: Query) => Query) {
  const projectIds = await projectIdsFor(user);
  const chunks = Array.from({ length: Math.ceil(projectIds.length / 30) }, (_, index) => projectIds.slice(index * 30, index * 30 + 30));
  const counts = await Promise.all(chunks.map((ids) => aggregateCount(filters(adminDb().collection(collection).where("projectId", "in", ids)))));
  return counts.reduce((sum, count) => sum + count, 0);
}

async function getDashboardTotals(user: SessionUser, workDate: string) {
  const db = adminDb();
  const clientQuery = await scopedQuery("clients", user);
  const projectQuery = await scopedQuery("projects", user);
  const requestQuery = await scopedQuery("projectRequests", user);
  const activeProjectStatuses = ["approved", "planning", "in_progress", "on_hold", "blocked", "in_review"];
  const allProjectStatuses = ["draft", "pending_cto_review", "approved", "planning", "in_progress", "on_hold", "blocked", "in_review", "completed", "cancelled", "archived"];
  const openTaskStatuses = ["open", "in_progress", "blocked"];
  const activeClients = aggregateCount(clientQuery.where("status", "==", "active"));
  const projectStatusCounts = Promise.all(allProjectStatuses.map(async (status) => ({
    status,
    count: await aggregateCount(projectQuery.where("status", "==", status)),
  })));
  const overdueProjects = aggregateCount(projectQuery.where("expectedEndDate", "<", workDate).where("status", "not-in", ["completed", "cancelled", "archived"]));
  const pendingProjectRequests = aggregateCount(requestQuery.where("status", "==", "pending_cto_review"));
  const changesRequested = aggregateCount(requestQuery.where("status", "==", "changes_requested"));
  let reportToday: Promise<number>;
  let reportsAwaitingReview: Promise<number>;
  if (user.role === "cto" || user.role === "product_manager") {
    reportToday = scopedProjectCount("workReports", user, (query) => query.where("workDate", "==", workDate));
    reportsAwaitingReview = scopedProjectCount("workReports", user, (query) => query.where("status", "in", ["submitted", "under_review"]));
  } else {
    const reportBase = await scopedQuery("workReports", user);
    reportToday = aggregateCount(reportBase.where("workDate", "==", workDate));
    reportsAwaitingReview = aggregateCount(reportBase.where("status", "in", ["submitted", "under_review"]));
  }
  let activeTeamMembers: Promise<number> = Promise.resolve(0);
  if (user.role === "super_admin" || user.role === "cto") {
    activeTeamMembers = aggregateCount(db.collection("users").where("role", "==", "team_member").where("accountStatus", "==", "active"));
  }
  let openTasks: Promise<number> = Promise.resolve(0);
  let upcomingTasks: Promise<number> = Promise.resolve(0);
  if (user.role === "team_member") {
    openTasks = scopedProjectCount("tasks", user, (query) => query.where("assigneeId", "==", user.uid).where("status", "in", openTaskStatuses));
    upcomingTasks = scopedProjectCount("tasks", user, (query) => query.where("assigneeId", "==", user.uid).where("dueDate", ">=", workDate).where("status", "in", openTaskStatuses));
  } else if (user.role === "super_admin") {
    const taskQuery = db.collection("tasks");
    openTasks = aggregateCount(taskQuery.where("status", "in", openTaskStatuses));
    upcomingTasks = aggregateCount(taskQuery.where("dueDate", ">=", workDate).where("status", "in", openTaskStatuses));
  } else if (user.role === "cto" || user.role === "product_manager") {
    openTasks = scopedProjectCount("tasks", user, (query) => query.where("status", "in", openTaskStatuses));
    upcomingTasks = scopedProjectCount("tasks", user, (query) => query.where("dueDate", ">=", workDate).where("status", "in", openTaskStatuses));
  }
  const projectStatuses = await projectStatusCounts;
  return {
    activeClients: await activeClients,
    activeProjects: projectStatuses.filter((item) => activeProjectStatuses.includes(item.status)).reduce((sum, item) => sum + item.count, 0),
    completedProjects: projectStatuses.find((item) => item.status === "completed")?.count ?? 0,
    projectStatuses: projectStatuses.filter((item) => item.count > 0),
    overdueProjects: await overdueProjects,
    pendingProjectRequests: await pendingProjectRequests,
    changesRequested: await changesRequested,
    reportsAwaitingReview: await reportsAwaitingReview,
    reportsToday: await reportToday,
    activeTeamMembers: await activeTeamMembers,
    openTasks: await openTasks,
    upcomingTasks: await upcomingTasks,
  };
}

export function serverTimestamp() {
  return FieldValue.serverTimestamp();
}

export function nowIso() {
  return new Date().toISOString();
}
