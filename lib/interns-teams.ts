import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminDb } from "@/lib/firebase-admin";
import { addAuditToBatch, auditEntry } from "@/lib/data";
import { HttpError, parseBody } from "@/lib/http";
import { projectApprovalStatus, stringArray } from "@/lib/project-approval";
import { syncProjectAssignments } from "@/lib/assignments";
import type { SessionUser } from "@/lib/types";

const INTERN_STATUSES = ["active", "completed", "discontinued"] as const;

const idList = z.preprocess(
  (value) => typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : value,
  z.array(z.string().trim().min(1).max(128)).max(100),
).transform((values) => [...new Set(values)]);

const optionalEmail = z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? undefined : value,
  z.email().max(254).transform((value) => value.trim().toLowerCase()).optional(),
);

const internFields = {
  fullName: z.string().trim().min(2).max(120),
  role: z.string().trim().min(2).max(100),
  email: optionalEmail,
  phone: z.string().trim().max(24).optional(),
  college: z.string().trim().max(160).optional(),
  joiningDate: z.string().date(),
  endDate: z.string().date().optional(),
  status: z.enum(INTERN_STATUSES).optional(),
  teamIds: idList.optional(),
  projectIds: idList.optional(),
  notes: z.string().trim().max(2000).optional(),
};

// The intern ID is generated on save, so it is never part of the submitted form.
const internCreateSchema = z.object(internFields);

// On edit, an empty string clears an optional field.
const internUpdateSchema = z.object({
  fullName: internFields.fullName.optional(),
  role: internFields.role.optional(),
  email: z.union([z.literal(""), z.email().max(254).transform((value) => value.trim().toLowerCase())]).optional(),
  phone: internFields.phone,
  college: internFields.college,
  joiningDate: internFields.joiningDate.optional(),
  endDate: z.union([z.literal(""), z.string().date()]).optional(),
  status: internFields.status,
  teamIds: internFields.teamIds,
  projectIds: internFields.projectIds,
  notes: internFields.notes,
});

const teamSchema = z.object({
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(100),
  description: z.string().trim().max(2000).optional(),
  memberUids: idList.optional(),
  internIds: idList.optional(),
  projectIds: idList.optional(),
});

const teamUpdateSchema = teamSchema.partial();

function requireSuperAdmin(user: SessionUser) {
  if (user.role !== "super_admin") throw new HttpError("Only a Super Admin can manage interns and teams.", 403);
}

function assertDateOrder(start: unknown, end: unknown) {
  if (typeof start === "string" && typeof end === "string" && start && end && end < start) {
    throw new HttpError("The end date must be on or after the joining date.", 400);
  }
}

/** New links may only point at approved projects. Links that already existed are kept as long as the project exists. */
async function validateProjects(ids: string[], alreadyLinked: string[] = []) {
  const db = adminDb();
  const projects = await Promise.all(ids.map((id) => db.collection("projects").doc(id).get()));
  for (const project of projects) {
    if (!project.exists) throw new HttpError("One of the selected projects no longer exists.", 400);
    if (!alreadyLinked.includes(project.id) && projectApprovalStatus(project.data()!) !== "approved") {
      throw new HttpError(`${String(project.data()?.name ?? "A selected project")} is awaiting approval. Approve it before assigning people.`, 409);
    }
  }
}

async function validateTeamUsers(ids: string[]) {
  const db = adminDb();
  const users = await Promise.all(ids.map((uid) => db.collection("users").doc(uid).get()));
  if (users.some((user) => !user.exists || user.data()?.role !== "team_member" || user.data()?.accountStatus !== "active")) {
    throw new HttpError("Only active team member accounts can be added to a team.", 400);
  }
}

async function validateInterns(ids: string[]) {
  const db = adminDb();
  const interns = await Promise.all(ids.map((id) => db.collection("interns").doc(id).get()));
  if (interns.some((intern) => !intern.exists)) throw new HttpError("One of the selected interns no longer exists.", 400);
}

function defined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

const INTERN_ID_PREFIX = "BSITS-";

/** Reserves the next free sequential intern ID (BSITS-001, BSITS-002, …) while the create transaction is open. */
async function nextInternId(transaction: FirebaseFirestore.Transaction) {
  const db = adminDb();
  const counterRef = db.collection("counters").doc("interns");
  const counter = await transaction.get(counterRef);
  let sequence = Number(counter.data()?.nextSequence ?? 0);
  if (!Number.isInteger(sequence) || sequence < 1) {
    // First run, or a counter that was never written: continue after the highest sequence already issued.
    const latest = await transaction.get(db.collection("interns").orderBy("internSequence", "desc").limit(1));
    sequence = Number(latest.docs[0]?.data()?.internSequence ?? 0) + 1;
  }
  // Interns added before IDs were generated may already hold one of these IDs, so skip any that is taken.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const internId = `${INTERN_ID_PREFIX}${String(sequence).padStart(3, "0")}`;
    const existing = await transaction.get(db.collection("interns").doc(internId));
    if (!existing.exists) return { internId, sequence, counterRef };
    sequence += 1;
  }
  throw new HttpError("Could not generate an intern ID. Try again.", 500);
}

export async function createIntern(request: Request, user: SessionUser) {
  requireSuperAdmin(user);
  const input = await parseBody(request, internCreateSchema);
  assertDateOrder(input.joiningDate, input.endDate);
  const projectIds = input.projectIds ?? [];
  const teamIds = input.teamIds ?? [];
  const [selectedTeams] = await Promise.all([assertTeamsExist(teamIds), validateProjects(projectIds)]);
  const db = adminDb();
  const record = {
    fullName: input.fullName,
    role: input.role,
    email: input.email ?? "",
    phone: input.phone ?? "",
    college: input.college ?? "",
    joiningDate: input.joiningDate,
    endDate: input.endDate ?? "",
    status: input.status ?? "active",
    projectIds,
    notes: input.notes ?? "",
    createdBy: user.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const auditRef = db.collection("auditLogs").doc();
  const stored = await db.runTransaction(async (transaction) => {
    const next = await nextInternId(transaction);
    const intern = { ...record, id: next.internId, internId: next.internId, internIdLower: next.internId.toLowerCase(), internSequence: next.sequence };
    transaction.set(db.collection("interns").doc(next.internId), intern);
    transaction.set(next.counterRef, { nextSequence: next.sequence + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    for (const team of selectedTeams) transaction.update(team.ref, { internIds: FieldValue.arrayUnion(next.internId), updatedAt: FieldValue.serverTimestamp() });
    transaction.set(auditRef, auditEntry(user, "intern_added", "interns", next.internId, { fullName: input.fullName, role: input.role, teamIds, projectIds }));
    return intern;
  });
  // Joining a team also puts the intern on that team's projects.
  await syncProjectAssignments([...projectIds, ...selectedTeams.flatMap((team) => stringArray(team.data()?.projectIds))]);
  return { ...stored, createdAt: null, updatedAt: null };
}

export async function updateIntern(id: string, request: Request, user: SessionUser) {
  requireSuperAdmin(user);
  const input = await parseBody(request, internUpdateSchema);
  const db = adminDb();
  const ref = db.collection("interns").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError("Intern not found.", 404);
  const current = snapshot.data()!;
  assertDateOrder(input.joiningDate ?? current.joiningDate, input.endDate ?? current.endDate);
  const previousProjects = stringArray(current.projectIds);
  if (input.projectIds) await validateProjects(input.projectIds, previousProjects);
  // Team membership lives on the team, not on the intern, so it is applied separately from the intern's own fields.
  const { teamIds, ...internInput } = input;
  const [selectedTeams, currentTeams] = await Promise.all([
    teamIds ? assertTeamsExist(teamIds) : Promise.resolve([]),
    db.collection("teams").where("internIds", "array-contains", id).get(),
  ]);
  const changes = defined(internInput);
  const batch = db.batch();
  batch.update(ref, { ...changes, updatedAt: FieldValue.serverTimestamp() });
  if (teamIds) {
    for (const team of selectedTeams.filter((team) => !currentTeams.docs.some((joined) => joined.id === team.id))) {
      batch.update(team.ref, { internIds: FieldValue.arrayUnion(id), updatedAt: FieldValue.serverTimestamp() });
    }
    for (const team of currentTeams.docs.filter((joined) => !teamIds.includes(joined.id))) {
      batch.update(team.ref, { internIds: FieldValue.arrayRemove(id), updatedAt: FieldValue.serverTimestamp() });
    }
  }
  addAuditToBatch(batch, user, "intern_updated", "interns", id, { changedFields: Object.keys(changes), ...(input.projectIds ? { projectIds: input.projectIds } : {}), ...(teamIds ? { teamIds } : {}) });
  await batch.commit();
  // Name, role, team, and project changes all show up in project summaries, including projects reached through a team.
  await syncProjectAssignments([
    ...previousProjects,
    ...(input.projectIds ?? []),
    ...currentTeams.docs.flatMap((team) => stringArray(team.data().projectIds)),
    ...selectedTeams.flatMap((team) => stringArray(team.data()?.projectIds)),
  ]);
  return { id, ...changes, ...(teamIds ? { teamIds } : {}) };
}

export async function deleteIntern(id: string, user: SessionUser) {
  requireSuperAdmin(user);
  const db = adminDb();
  const ref = db.collection("interns").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError("Intern not found.", 404);
  const teams = await db.collection("teams").where("internIds", "array-contains", id).get();
  const batch = db.batch();
  for (const team of teams.docs) batch.update(team.ref, { internIds: FieldValue.arrayRemove(id), updatedAt: FieldValue.serverTimestamp() });
  batch.delete(ref);
  addAuditToBatch(batch, user, "intern_removed", "interns", id, { fullName: String(snapshot.data()?.fullName ?? ""), teamIds: teams.docs.map((team) => team.id) });
  await batch.commit();
  await syncProjectAssignments([...stringArray(snapshot.data()?.projectIds), ...teams.docs.flatMap((team) => stringArray(team.data().projectIds))]);
  return { id, deleted: true };
}

async function assertUniqueTeamName(name: string, exceptId?: string) {
  const matches = await adminDb().collection("teams").where("nameLower", "==", name.toLowerCase()).limit(2).get();
  if (matches.docs.some((team) => team.id !== exceptId)) throw new HttpError("A team with this name already exists.", 409);
}

export async function createTeam(request: Request, user: SessionUser) {
  requireSuperAdmin(user);
  const input = await parseBody(request, teamSchema);
  const memberUids = input.memberUids ?? [];
  const internIds = input.internIds ?? [];
  const projectIds = input.projectIds ?? [];
  await Promise.all([assertUniqueTeamName(input.name), validateTeamUsers(memberUids), validateInterns(internIds), validateProjects(projectIds)]);
  const db = adminDb();
  const ref = db.collection("teams").doc();
  const record = {
    id: ref.id,
    name: input.name,
    nameLower: input.name.toLowerCase(),
    category: input.category,
    description: input.description ?? "",
    memberUids,
    internIds,
    projectIds,
    createdBy: user.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const batch = db.batch();
  batch.set(ref, record);
  addAuditToBatch(batch, user, "team_created", "teams", ref.id, { name: input.name, category: input.category, memberUids, internIds, projectIds });
  await batch.commit();
  await syncProjectAssignments(projectIds);
  return { ...record, createdAt: null, updatedAt: null };
}

export async function updateTeam(id: string, request: Request, user: SessionUser) {
  requireSuperAdmin(user);
  const input = await parseBody(request, teamUpdateSchema);
  const db = adminDb();
  const ref = db.collection("teams").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError("Team not found.", 404);
  const current = snapshot.data()!;
  const previousProjects = stringArray(current.projectIds);
  const previousMembers = stringArray(current.memberUids);
  // Members who were added earlier stay valid even if their account changed since; only new additions are checked.
  const addedMembers = (input.memberUids ?? []).filter((uid) => !previousMembers.includes(uid));
  await Promise.all([
    input.name ? assertUniqueTeamName(input.name, id) : Promise.resolve(),
    validateTeamUsers(addedMembers),
    input.internIds ? validateInterns(input.internIds) : Promise.resolve(),
    input.projectIds ? validateProjects(input.projectIds, previousProjects) : Promise.resolve(),
  ]);
  const changes = defined({ ...input, ...(input.name ? { nameLower: input.name.toLowerCase() } : {}) });
  const batch = db.batch();
  batch.update(ref, { ...changes, updatedAt: FieldValue.serverTimestamp() });
  addAuditToBatch(batch, user, "team_updated", "teams", id, { changedFields: Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined), ...defined({ memberUids: input.memberUids, internIds: input.internIds, projectIds: input.projectIds }) });
  await batch.commit();
  await syncProjectAssignments([...previousProjects, ...(input.projectIds ?? [])]);
  return { id, ...changes };
}

export async function deleteTeam(id: string, user: SessionUser) {
  requireSuperAdmin(user);
  const db = adminDb();
  const ref = db.collection("teams").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError("Team not found.", 404);
  const batch = db.batch();
  batch.delete(ref);
  addAuditToBatch(batch, user, "team_deleted", "teams", id, { name: String(snapshot.data()?.name ?? "") });
  await batch.commit();
  await syncProjectAssignments(stringArray(snapshot.data()?.projectIds));
  return { id, deleted: true };
}

/** Links teams to a project (adding and removing links so the project ends up with exactly these teams). */
export async function setProjectTeams(projectId: string, teamIds: string[]) {
  const db = adminDb();
  const [linked, requested] = await Promise.all([
    db.collection("teams").where("projectIds", "array-contains", projectId).get(),
    Promise.all([...new Set(teamIds)].map((id) => db.collection("teams").doc(id).get())),
  ]);
  if (requested.some((team) => !team.exists)) throw new HttpError("One of the selected teams no longer exists.", 400);
  const wanted = new Set(requested.map((team) => team.id));
  const batch = db.batch();
  for (const team of requested) if (!stringArray(team.data()?.projectIds).includes(projectId)) batch.update(team.ref, { projectIds: FieldValue.arrayUnion(projectId), updatedAt: FieldValue.serverTimestamp() });
  for (const team of linked.docs) if (!wanted.has(team.id)) batch.update(team.ref, { projectIds: FieldValue.arrayRemove(projectId), updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();
  return requested.map((team) => ({ id: team.id, name: String(team.data()?.name ?? "Team") }));
}

/** Validates that every team exists before a review links them. */
export async function assertTeamsExist(teamIds: string[]) {
  const db = adminDb();
  const teams = await Promise.all([...new Set(teamIds)].map((id) => db.collection("teams").doc(id).get()));
  if (teams.some((team) => !team.exists)) throw new HttpError("One of the selected teams no longer exists.", 400);
  return teams;
}
