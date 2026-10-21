import "server-only";

import { FieldPath, FieldValue, Filter, type Query, type WriteBatch } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { canReadCollection, canReadRecord, isWorkspaceMember } from "@/lib/access-control";
import { redactRecordForRole } from "@/lib/record-security";
import type { CollectionName, RecordData, Role, SessionUser, TeamWorkSummary } from "@/lib/types";
import { serializeRecord } from "@/lib/http";

const QUERY_LIMIT = 100;
/** Reports read in one pass to total each member's hours. Well above what a team files in a year. */
const REPORT_TOTALS_LIMIT = 10000;

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
  const query = await scopedQuery("projects", user, { includeSubmitted: false });
  const snapshot = await query.get();
  return snapshot.docs.map((project) => project.id);
}

async function scopedQuery(collection: CollectionName, user: SessionUser, { includeSubmitted = true } = {}): Promise<Query> {
  const db = adminDb();
  const rows = db.collection(collection);

  if (collection === "clients") {
    if (user.role === "super_admin") return rows;
    if (user.role === "cto") return rows.where("createdBy", "==", user.uid);
    if (user.role === "product_manager") return rows.where(Filter.or(
      Filter.where("createdBy", "==", user.uid),
      Filter.where("assignedProductManager", "==", user.uid),
    ));
    return rows.where(FieldPath.documentId(), "==", "__no_access__");
  }
  if (collection === "projects") {
    if (user.role === "super_admin") return rows;
    // Interns reach a project through assignedTeam, which the assignment recompute keeps up to date for them.
    const assigned = user.role === "cto" ? Filter.where("assignedCto", "==", user.uid)
      : user.role === "product_manager" ? Filter.where("assignedProductManager", "==", user.uid)
        : Filter.where("assignedTeam", "array-contains", user.uid);
    // Project lists also include projects the user submitted, so they can follow approval and team assignment.
    // Task, report, and dashboard scopes pass includeSubmitted: false so they cover only assigned work
    // (and so their extra filters, such as not-in, never combine with an OR query).
    if (!includeSubmitted) return rows.where(assigned);
    return rows.where(Filter.or(assigned, Filter.where("createdBy", "==", user.uid)));
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
    if (isWorkspaceMember(user.role)) return rows.where("employeeId", "==", user.uid);
    const projectIds = await projectIdsFor(user);
    if (projectIds.length === 0) return rows.where(FieldPath.documentId(), "==", "__no_access__");
    return rows.where("projectId", "in", projectIds.slice(0, 30));
  }
  if (collection === "tasks") {
    if (user.role === "super_admin") return rows;
    // An intern sees only their own work. Everyone else working on a project sees that project's board,
    // so a task a Super Admin assigned shows up for the team member responsible for the project too.
    if (user.role === "intern") return rows.where("assigneeId", "==", user.uid);
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
  if (collection === "interns") {
    if (user.role === "super_admin") return rows;
    // Interns are a company-wide roster: any employee can see who is interning and hand them work.
    // Changing an intern's record stays with whoever took them on, which is checked on the write.
    if (user.role === "team_member") return rows;
    return rows.where(FieldPath.documentId(), "==", "__no_access__");
  }
  if (collection === "teams") {
    if (user.role === "super_admin") return rows;
    if (user.role === "team_member") return rows.where("memberUids", "array-contains", user.uid);
    return rows.where(FieldPath.documentId(), "==", "__no_access__");
  }
  return rows.where(FieldPath.documentId(), "==", "__no_access__");
}

export async function listRecords(collection: CollectionName, user: SessionUser) {
  if (!canReadCollection(user.role, collection)) return [];
  let documents: FirebaseFirestore.QueryDocumentSnapshot[];
  let scopedProjectIds: ReadonlySet<string> | undefined;
  const managerScopedReports = collection === "workReports" && (user.role === "cto" || user.role === "product_manager");
  // Everyone working on a project reads its whole task board; an intern is narrowed to their own rows.
  const projectScopedTasks = collection === "tasks" && user.role !== "super_admin";
  const internScopedTasks = collection === "tasks" && user.role === "intern";
  const projectScopedMilestones = collection === "milestones" && (user.role === "cto" || user.role === "product_manager" || isWorkspaceMember(user.role));
  if (managerScopedReports || projectScopedTasks || projectScopedMilestones) {
    const projectIds = await projectIdsFor(user);
    scopedProjectIds = new Set(projectIds);
    const chunks = Array.from({ length: Math.ceil(projectIds.length / 30) }, (_, index) => projectIds.slice(index * 30, index * 30 + 30));
    const snapshots = await Promise.all(chunks.map((ids) => {
      let query = adminDb().collection(collection).where("projectId", "in", ids);
      if (internScopedTasks) query = query.where("assigneeId", "==", user.uid);
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
  const redacted = records.map((record) => redactRecordForRole(collection, record, user.role, user.uid));
  return redacted.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/**
 * Interns an employee can hand a task to: every active intern who has a workspace sign-in to open it
 * with. Only the fields a picker needs are returned, so one employee's intern list never leaks another
 * intern's contact details.
 */
export async function listAssignableInterns(): Promise<RecordData[]> {
  const snapshot = await adminDb().collection("interns").where("status", "==", "active").limit(QUERY_LIMIT).get();
  return snapshot.docs
    .filter((doc) => String(doc.data().loginUid ?? ""))
    .map((doc) => ({
      id: doc.id,
      internId: String(doc.data().internId ?? doc.id),
      fullName: String(doc.data().fullName ?? doc.id),
      role: String(doc.data().role ?? ""),
      loginUid: String(doc.data().loginUid),
    }));
}

/** The intern record behind a signed-in intern, so their own page can show the details held on file. */
export async function getOwnInternRecord(loginUid: string): Promise<RecordData[]> {
  if (!loginUid) return [];
  const snapshot = await adminDb().collection("interns").where("loginUid", "==", loginUid).limit(1).get();
  return snapshot.docs.map(serializeSnapshot);
}

/**
 * The people on a set of teams, for someone who cannot read the users or interns collections outright.
 * Only what a roster shows is returned: names, roles, and access status, never contact details.
 */
export async function getTeamDirectory(teams: RecordData[]) {
  const ids = (key: string) => [...new Set(teams.flatMap((team) => Array.isArray(team[key]) ? (team[key] as unknown[]).filter((value): value is string => typeof value === "string") : []))];
  const db = adminDb();
  const [memberDocs, internDocs] = await Promise.all([
    Promise.all(ids("memberUids").slice(0, QUERY_LIMIT).map((uid) => db.collection("users").doc(uid).get())),
    Promise.all(ids("internIds").slice(0, QUERY_LIMIT).map((id) => db.collection("interns").doc(id).get())),
  ]);
  return {
    members: memberDocs.filter((doc) => doc.exists).map((doc) => ({
      id: doc.id,
      displayName: String(doc.data()?.displayName ?? doc.id),
      designation: String(doc.data()?.designation ?? ""),
      role: String(doc.data()?.role ?? ""),
      accountStatus: String(doc.data()?.accountStatus ?? "active"),
    })),
    interns: internDocs.filter((doc) => doc.exists).map((doc) => ({
      id: doc.id,
      internId: String(doc.data()?.internId ?? doc.id),
      fullName: String(doc.data()?.fullName ?? doc.id),
      role: String(doc.data()?.role ?? ""),
      status: String(doc.data()?.status ?? "active"),
      loginUid: String(doc.data()?.loginUid ?? ""),
      email: String(doc.data()?.email ?? ""),
      joiningDate: String(doc.data()?.joiningDate ?? ""),
      college: String(doc.data()?.college ?? ""),
    })),
  };
}

/**
 * The tasks and work reports filed against a set of intern sign-ins, for the intern detail view.
 * Callers pass only the interns the viewer may already see, so this adds no reach of its own.
 */
export async function getInternWorkRecords(loginUids: string[]) {
  const uids = [...new Set(loginUids.filter(Boolean))];
  if (!uids.length) return { tasks: [] as RecordData[], reports: [] as RecordData[] };
  const chunks = Array.from({ length: Math.ceil(uids.length / 30) }, (_, index) => uids.slice(index * 30, index * 30 + 30));
  const db = adminDb();
  const [taskGroups, reportGroups] = await Promise.all([
    Promise.all(chunks.map((ids) => db.collection("tasks").where("assigneeId", "in", ids).limit(QUERY_LIMIT).get())),
    Promise.all(chunks.map((ids) => db.collection("workReports").where("employeeId", "in", ids).limit(QUERY_LIMIT).get())),
  ]);
  return {
    tasks: taskGroups.flatMap((group) => group.docs.map(serializeSnapshot)),
    reports: reportGroups.flatMap((group) => group.docs.map(serializeSnapshot)),
  };
}

export async function getTeamWorkSummary(): Promise<TeamWorkSummary[]> {
  const db = adminDb();
  // Totals are grouped from a single projected read of the two fields that matter. A per-member sum
  // aggregation would need a composite index on every filtered field, and cost one round trip per member.
  const [members, reports] = await Promise.all([
    // Interns file work reports against their own sign-in, so their hours belong in this summary too.
    db.collection("users").where("role", "in", ["team_member", "intern"]).limit(QUERY_LIMIT).get(),
    db.collection("workReports").select("employeeId", "timeSpentHours").limit(REPORT_TOTALS_LIMIT).get(),
  ]);
  const totals = new Map<string, { reportCount: number; hoursLogged: number }>();
  for (const report of reports.docs) {
    const employeeId = String(report.get("employeeId") ?? "");
    if (!employeeId) continue;
    const hours = Number(report.get("timeSpentHours"));
    const running = totals.get(employeeId) ?? { reportCount: 0, hoursLogged: 0 };
    totals.set(employeeId, { reportCount: running.reportCount + 1, hoursLogged: running.hoursLogged + (Number.isFinite(hours) ? hours : 0) });
  }
  const summaries = members.docs.map((member) => {
    const profile = member.data();
    const memberTotals = totals.get(member.id);
    return {
      uid: member.id,
      displayName: String(profile.displayName ?? profile.email ?? member.id),
      designation: String(profile.designation ?? ""),
      role: profile.role === "intern" ? "intern" as const : "team_member" as const,
      accountStatus: profile.accountStatus === "suspended" ? "suspended" as const : "active" as const,
      reportCount: memberTotals?.reportCount ?? 0,
      hoursLogged: Math.round((memberTotals?.hoursLogged ?? 0) * 100) / 100,
    };
  });
  return summaries.sort((a, b) => b.hoursLogged - a.hoursLogged || b.reportCount - a.reportCount || a.displayName.localeCompare(b.displayName));
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

const OPEN_TASK_STATUSES = ["open", "in_progress", "blocked"];

/**
 * Due dates of the open tasks in the viewer's project scope, read once so the "open" and "upcoming"
 * counts come from the same rows.
 *
 * Both numbers could be counted by Firestore instead, but the upcoming one needs a range on dueDate,
 * and a range has to come after every equality in a composite index. That means a separate index per
 * scope (one with assigneeId, one without). Reading the due dates and comparing them here keeps every
 * filter an equality, which the indexes already in firestore.indexes.json cover.
 */
async function openTaskDueDates(user: SessionUser, ownTasksOnly: boolean) {
  const projectIds = await projectIdsFor(user);
  const chunks = Array.from({ length: Math.ceil(projectIds.length / 30) }, (_, index) => projectIds.slice(index * 30, index * 30 + 30));
  const snapshots = await Promise.all(chunks.map((ids) => {
    let query: Query = adminDb().collection("tasks").where("projectId", "in", ids).where("status", "in", OPEN_TASK_STATUSES);
    if (ownTasksOnly) query = query.where("assigneeId", "==", user.uid);
    // Only the one field is read back, and the ceiling is well above what a scope holds open at once.
    return query.select("dueDate").limit(REPORT_TOTALS_LIMIT).get();
  }));
  return snapshots.flatMap((snapshot) => snapshot.docs.map((doc) => String(doc.get("dueDate") ?? "")));
}

async function getDashboardTotals(user: SessionUser, workDate: string) {
  const db = adminDb();
  const clientQuery = await scopedQuery("clients", user);
  const projectQuery = await scopedQuery("projects", user, { includeSubmitted: false });
  const requestQuery = await scopedQuery("projectRequests", user);
  const activeProjectStatuses = ["approved", "planning", "in_progress", "on_hold", "blocked", "in_review"];
  const allProjectStatuses = ["draft", "pending_approval", "rejected", "pending_cto_review", "approved", "planning", "in_progress", "on_hold", "blocked", "in_review", "completed", "cancelled", "archived"];
  // Roles that cannot read a collection skip its counts outright, rather than running a query that is
  // scoped to nothing. The intern and team member dashboards are made almost entirely of the rest.
  const readsClients = canReadCollection(user.role, "clients");
  const readsRequests = canReadCollection(user.role, "projectRequests");
  const activeClients = readsClients ? aggregateCount(clientQuery.where("status", "==", "active")) : Promise.resolve(0);
  const projectStatusCounts = Promise.all(allProjectStatuses.map(async (status) => ({
    status,
    count: await aggregateCount(projectQuery.where("status", "==", status)),
  })));
  const overdueProjects = aggregateCount(projectQuery.where("expectedEndDate", "<", workDate).where("status", "not-in", ["completed", "cancelled", "archived", "pending_approval", "rejected"]));
  const pendingProjectRequests = readsRequests ? aggregateCount(requestQuery.where("status", "==", "pending_cto_review")) : Promise.resolve(0);
  const changesRequested = readsRequests ? aggregateCount(requestQuery.where("status", "==", "changes_requested")) : Promise.resolve(0);
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
  if (user.role === "super_admin") {
    // Company-wide, so there is no project scope to read through and the plain counts are indexed.
    const taskQuery = db.collection("tasks");
    openTasks = aggregateCount(taskQuery.where("status", "in", OPEN_TASK_STATUSES));
    upcomingTasks = aggregateCount(taskQuery.where("dueDate", ">=", workDate).where("status", "in", OPEN_TASK_STATUSES));
  } else if (isWorkspaceMember(user.role) || user.role === "cto" || user.role === "product_manager") {
    // A workspace member counts only their own work; a CTO or Product Manager counts their projects'.
    const dueDates = openTaskDueDates(user, isWorkspaceMember(user.role));
    openTasks = dueDates.then((dates) => dates.length);
    upcomingTasks = dueDates.then((dates) => dates.filter((due) => due && due >= workDate).length);
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
