import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { addAuditToBatch, auditEntry } from "@/lib/data";
import { HttpError, parseBody } from "@/lib/http";
import { checkPhone, PHONE_INPUT_MAX } from "@/lib/phone";
import { projectApprovalStatus, stringArray } from "@/lib/project-approval";
import { syncProjectAssignments } from "@/lib/assignments";
import type { SessionUser } from "@/lib/types";

// "suspended" pauses an internship that is still running; the other two end it. Anything but "active"
// disables the intern's sign-in and takes them off project rosters until they are active again.
const INTERN_STATUSES = ["active", "suspended", "completed", "discontinued"] as const;

const idList = z.preprocess(
  (value) => typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : value,
  z.array(z.string().trim().min(1).max(128)).max(100),
).transform((values) => [...new Set(values)]);

const optionalEmail = z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? undefined : value,
  z.email().max(254).transform((value) => value.trim().toLowerCase()).optional(),
);

/** Blank means "leave the sign-in password as it is", so an empty box is not a validation error. */
const optionalPassword = z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? undefined : value,
  z.string().min(8, "Use at least 8 characters for the intern's password.").max(128).optional(),
);

/** Rejects a badly formed number and leaves an empty box alone, with the same wording the form uses. */
function phoneIssue(value: string | undefined, ctx: z.RefinementCtx) {
  if (!value) return;
  const result = checkPhone(value);
  if (!result.ok) ctx.addIssue({ code: "custom", message: result.error });
}

const optionalPhone = z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? undefined : value,
  z.string().max(PHONE_INPUT_MAX).optional().superRefine(phoneIssue),
);

const internFields = {
  fullName: z.string().trim().min(2).max(120),
  role: z.string().trim().min(2).max(100),
  email: optionalEmail,
  phone: optionalPhone,
  college: z.string().trim().max(160).optional(),
  joiningDate: z.string().date(),
  endDate: z.string().date().optional(),
  status: z.enum(INTERN_STATUSES).optional(),
  teamIds: idList.optional(),
  projectIds: idList.optional(),
  notes: z.string().trim().max(2000).optional(),
  password: optionalPassword,
};

// The intern ID is generated on save, so it is never part of the submitted form.
const internCreateSchema = z.object(internFields).refine((input) => !input.password || Boolean(input.email), {
  message: "Add the intern's email address to create their sign-in.",
  path: ["email"],
});

// On edit, an empty string clears an optional field.
const internUpdateSchema = z.object({
  fullName: internFields.fullName.optional(),
  role: internFields.role.optional(),
  email: z.union([z.literal(""), z.email().max(254).transform((value) => value.trim().toLowerCase())]).optional(),
  // On edit an empty string clears the number, so it is validated only when one was actually typed.
  phone: z.string().max(PHONE_INPUT_MAX).optional().superRefine(phoneIssue),
  college: internFields.college,
  joiningDate: internFields.joiningDate.optional(),
  endDate: z.union([z.literal(""), z.string().date()]).optional(),
  status: internFields.status,
  teamIds: internFields.teamIds,
  projectIds: internFields.projectIds,
  notes: internFields.notes,
  password: internFields.password,
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

/** Interns are taken on by a Super Admin or by the full-time employee who will supervise them. */
function requireInternManager(user: SessionUser) {
  if (user.role !== "super_admin" && user.role !== "team_member") {
    throw new HttpError("Only a Super Admin or a full-time employee can add interns.", 403);
  }
}

function assertCanEditIntern(user: SessionUser, current: FirebaseFirestore.DocumentData) {
  if (user.role === "super_admin") return;
  if (user.role === "team_member" && current.createdBy === user.uid) return;
  throw new HttpError("You can only edit interns you added.", 403);
}

/** An employee may only place an intern on work they are on themselves. Teams stay a Super Admin decision. */
async function assertEmployeeInternScope(user: SessionUser, teamIds: string[], projectIds: string[]) {
  if (user.role !== "team_member") return;
  if (teamIds.length) throw new HttpError("Only a Super Admin can add an intern to a team.", 403);
  if (!projectIds.length) return;
  const db = adminDb();
  const projects = await Promise.all(projectIds.map((id) => db.collection("projects").doc(id).get()));
  if (projects.some((project) => !stringArray(project.data()?.assignedTeam).includes(user.uid))) {
    throw new HttpError("You can only put an intern on projects you are working on yourself.", 403);
  }
}

/** Two interns cannot share a phone number, whichever way each of them typed it. */
async function assertUniquePhone(phoneNormalized: string, exceptId?: string) {
  if (!phoneNormalized) return;
  const matches = await adminDb().collection("interns").where("phoneNormalized", "==", phoneNormalized).limit(2).get();
  if (matches.docs.some((doc) => doc.id !== exceptId)) {
    throw new HttpError("Another intern is already registered with this phone number.", 409);
  }
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

/** Maps the Firebase Auth failures a Super Admin can cause into messages they can act on. */
function loginError(error: unknown): never {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "auth/email-already-exists") throw new HttpError("Another account already uses this email address.", 409);
  if (code === "auth/invalid-password") throw new HttpError("Choose a longer password for this intern.", 400);
  if (code === "auth/invalid-email") throw new HttpError("Enter a valid email address for this intern.", 400);
  throw error;
}

/**
 * Creates the intern's workspace sign-in. The intern role gives them the same workspace scope as a team
 * member (their own projects, tasks, and work reports) and nothing else.
 */
async function createInternLogin(email: string, password: string, fullName: string, status: string) {
  let authUser;
  try {
    authUser = await adminAuth().createUser({ email, password, displayName: fullName, disabled: status !== "active" });
  } catch (error) {
    loginError(error);
  }
  try {
    await adminAuth().setCustomUserClaims(authUser.uid, { role: "intern" });
  } catch (error) {
    await adminAuth().deleteUser(authUser.uid).catch(() => undefined);
    throw error;
  }
  return authUser.uid;
}

/** The users profile an intern signs in against. It is the only place their role and access status live. */
function internLoginProfile(uid: string, intern: { internId: string; email: string; fullName: string; role: string; status: string }, createdBy: string) {
  return {
    uid,
    displayName: intern.fullName,
    email: intern.email,
    role: "intern",
    designation: intern.role,
    internId: intern.internId,
    accountStatus: intern.status === "active" ? "active" : "suspended",
    createdBy,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

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
  requireInternManager(user);
  const { password, ...input } = await parseBody(request, internCreateSchema);
  assertDateOrder(input.joiningDate, input.endDate);
  const projectIds = input.projectIds ?? [];
  const teamIds = input.teamIds ?? [];
  await assertEmployeeInternScope(user, teamIds, projectIds);
  const phone = input.phone ? checkPhone(input.phone) : null;
  const phoneNormalized = phone?.ok ? phone.phoneNormalized : "";
  const [selectedTeams] = await Promise.all([
    assertTeamsExist(teamIds),
    validateProjects(projectIds),
    assertUniquePhone(phoneNormalized),
  ]);
  const db = adminDb();
  const status = input.status ?? "active";
  // The sign-in is created before the intern record so a rejected email or password costs nothing.
  const loginUid = password ? await createInternLogin(input.email!, password, input.fullName, status) : "";
  const record = {
    fullName: input.fullName,
    role: input.role,
    email: input.email ?? "",
    phone: phone?.ok ? phone.phone : "",
    phoneNormalized,
    college: input.college ?? "",
    joiningDate: input.joiningDate,
    endDate: input.endDate ?? "",
    status,
    projectIds,
    notes: input.notes ?? "",
    loginUid,
    createdBy: user.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const auditRef = db.collection("auditLogs").doc();
  let stored;
  try {
    stored = await db.runTransaction(async (transaction) => {
      const next = await nextInternId(transaction);
      const intern = { ...record, id: next.internId, internId: next.internId, internIdLower: next.internId.toLowerCase(), internSequence: next.sequence };
      transaction.set(db.collection("interns").doc(next.internId), intern);
      transaction.set(next.counterRef, { nextSequence: next.sequence + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      if (loginUid) {
        transaction.set(db.collection("users").doc(loginUid), internLoginProfile(loginUid, { internId: next.internId, email: input.email!, fullName: input.fullName, role: input.role, status }, user.uid));
      }
      for (const team of selectedTeams) transaction.update(team.ref, { internIds: FieldValue.arrayUnion(next.internId), updatedAt: FieldValue.serverTimestamp() });
      transaction.set(auditRef, auditEntry(user, "intern_added", "interns", next.internId, { fullName: input.fullName, role: input.role, teamIds, projectIds, loginCreated: Boolean(loginUid) }));
      return intern;
    });
  } catch (error) {
    // Nothing was saved, so the sign-in must not be left behind without an intern record.
    if (loginUid) await adminAuth().deleteUser(loginUid).catch(() => undefined);
    throw error;
  }
  // Joining a team also puts the intern on that team's projects.
  await syncProjectAssignments([...projectIds, ...selectedTeams.flatMap((team) => stringArray(team.data()?.projectIds))]);
  return { ...stored, createdAt: null, updatedAt: null };
}

export async function updateIntern(id: string, request: Request, user: SessionUser) {
  requireInternManager(user);
  const input = await parseBody(request, internUpdateSchema);
  const db = adminDb();
  const ref = db.collection("interns").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError("Intern not found.", 404);
  const current = snapshot.data()!;
  assertCanEditIntern(user, current);
  assertDateOrder(input.joiningDate ?? current.joiningDate, input.endDate ?? current.endDate);
  const previousProjects = stringArray(current.projectIds);
  await assertEmployeeInternScope(user, input.teamIds ?? [], (input.projectIds ?? []).filter((projectId) => !previousProjects.includes(projectId)));
  if (input.projectIds) await validateProjects(input.projectIds, previousProjects);
  // An empty string clears the number; anything else replaces it and must stay unique.
  const phone = input.phone === undefined ? null : checkPhone(input.phone);
  if (phone?.ok) await assertUniquePhone(phone.phoneNormalized, id);
  // Team membership lives on the team, not on the intern, so it is applied separately from the intern's own fields.
  // The password is never stored on the record; it only goes to Firebase Authentication.
  const { teamIds, password, ...internInput } = input;
  const [selectedTeams, currentTeams] = await Promise.all([
    teamIds ? assertTeamsExist(teamIds) : Promise.resolve([]),
    db.collection("teams").where("internIds", "array-contains", id).get(),
  ]);
  const login = await applyInternLoginChanges(id, current, { ...internInput, password }, user);
  const changes = {
    ...defined(internInput),
    ...(phone?.ok ? { phone: phone.phone, phoneNormalized: phone.phoneNormalized } : {}),
    ...login.internChanges,
  };
  const batch = db.batch();
  batch.update(ref, { ...changes, updatedAt: FieldValue.serverTimestamp() });
  if (login.profileRef) batch.set(login.profileRef, login.profileChanges, { merge: true });
  // Team membership is a Super Admin arrangement, so an employee's edit never rewrites it.
  if (teamIds && user.role === "super_admin") {
    for (const team of selectedTeams.filter((team) => !currentTeams.docs.some((joined) => joined.id === team.id))) {
      batch.update(team.ref, { internIds: FieldValue.arrayUnion(id), updatedAt: FieldValue.serverTimestamp() });
    }
    for (const team of currentTeams.docs.filter((joined) => !teamIds.includes(joined.id))) {
      batch.update(team.ref, { internIds: FieldValue.arrayRemove(id), updatedAt: FieldValue.serverTimestamp() });
    }
  }
  addAuditToBatch(batch, user, "intern_updated", "interns", id, { changedFields: Object.keys(changes), ...(input.projectIds ? { projectIds: input.projectIds } : {}), ...(teamIds ? { teamIds } : {}), ...login.auditChanges });
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

/**
 * Applies an intern edit to their workspace sign-in: creates it when a password is set for the first time,
 * and otherwise keeps the email, password, name, designation, and access status in step with the record.
 * An internship that is completed or discontinued loses workspace access but keeps its history.
 *
 * Firebase Authentication is written first, because it is what the intern signs in against and it is the
 * step that can reject the new email or password.
 */
async function applyInternLoginChanges(
  id: string,
  current: FirebaseFirestore.DocumentData,
  input: { fullName?: string; role?: string; email?: string; status?: string; password?: string },
  user: SessionUser,
) {
  const loginUid = String(current.loginUid ?? "");
  const nextEmail = input.email === undefined ? String(current.email ?? "") : input.email;
  const nextName = input.fullName ?? String(current.fullName ?? "");
  const nextRole = input.role ?? String(current.role ?? "");
  const nextStatus = input.status ?? String(current.status ?? "active");
  const db = adminDb();

  if (!loginUid) {
    if (!input.password) return { internChanges: {}, profileRef: null, profileChanges: {}, auditChanges: {} };
    if (!nextEmail) throw new HttpError("Add an email address for this intern before setting a password.", 400);
    const createdUid = await createInternLogin(nextEmail, input.password, nextName, nextStatus);
    return {
      internChanges: { loginUid: createdUid },
      profileRef: db.collection("users").doc(createdUid),
      profileChanges: internLoginProfile(createdUid, { internId: String(current.internId ?? id), email: nextEmail, fullName: nextName, role: nextRole, status: nextStatus }, user.uid),
      auditChanges: { loginCreated: true },
    };
  }

  if (!nextEmail) throw new HttpError("This intern signs in with their email address, so it cannot be cleared.", 400);
  const accountStatus = nextStatus === "active" ? "active" : "suspended";
  const emailChanged = nextEmail !== String(current.email ?? "");
  try {
    await adminAuth().updateUser(loginUid, {
      ...(emailChanged ? { email: nextEmail } : {}),
      ...(input.password ? { password: input.password } : {}),
      displayName: nextName,
      disabled: accountStatus !== "active",
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "auth/user-not-found") throw new HttpError("This intern's sign-in no longer exists. Remove the intern and add them again.", 409);
    loginError(error);
  }
  return {
    internChanges: {},
    profileRef: db.collection("users").doc(loginUid),
    profileChanges: { displayName: nextName, email: nextEmail, designation: nextRole, accountStatus, updatedAt: FieldValue.serverTimestamp() },
    auditChanges: { ...(input.password ? { passwordReset: true } : {}), ...(emailChanged ? { loginEmailChanged: true } : {}), accountStatus },
  };
}

export async function deleteIntern(id: string, user: SessionUser) {
  requireInternManager(user);
  const db = adminDb();
  const ref = db.collection("interns").doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError("Intern not found.", 404);
  assertCanEditIntern(user, snapshot.data()!);
  const teams = await db.collection("teams").where("internIds", "array-contains", id).get();
  const loginUid = String(snapshot.data()?.loginUid ?? "");
  // An intern who has been given work is part of its history. Ending the internship keeps that record
  // intact; deleting would leave tasks and reports pointing at somebody who no longer exists.
  if (loginUid) {
    const [tasks, reports] = await Promise.all([
      db.collection("tasks").where("assigneeId", "==", loginUid).limit(1).get(),
      db.collection("workReports").where("employeeId", "==", loginUid).limit(1).get(),
    ]);
    if (!tasks.empty || !reports.empty) {
      throw new HttpError("This intern has tasks or work reports in the workspace, so removing them would leave that work without an owner. Set their status to suspended, completed, or discontinued instead.", 409);
    }
  }
  // Access is revoked before the record goes, so a failure part way through cannot leave a working sign-in.
  if (loginUid) {
    try {
      await adminAuth().deleteUser(loginUid);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "auth/user-not-found") throw new HttpError("This intern's sign-in could not be removed. Try again.", 503);
    }
  }
  const batch = db.batch();
  for (const team of teams.docs) batch.update(team.ref, { internIds: FieldValue.arrayRemove(id), updatedAt: FieldValue.serverTimestamp() });
  if (loginUid) batch.delete(db.collection("users").doc(loginUid));
  batch.delete(ref);
  addAuditToBatch(batch, user, "intern_removed", "interns", id, { fullName: String(snapshot.data()?.fullName ?? ""), teamIds: teams.docs.map((team) => team.id), ...(loginUid ? { loginRemoved: true } : {}) });
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

/**
 * Whether an employee is responsible for an intern: either they took them on, or the two of them share a
 * team. Used to decide who may review an intern's work reports.
 */
export async function canEmployeeManageIntern(uid: string, loginUid: string) {
  if (!loginUid) return false;
  const db = adminDb();
  const matches = await db.collection("interns").where("loginUid", "==", loginUid).limit(1).get();
  const intern = matches.docs[0];
  if (!intern) return false;
  if (intern.data().createdBy === uid) return true;
  const teams = await db.collection("teams").where("memberUids", "array-contains", uid).get();
  return teams.docs.some((team) => stringArray(team.data().internIds).includes(intern.id));
}

/**
 * Puts an intern on a project because they were handed a task on it, so their access and the project's
 * roster never disagree. Returns the intern record the sign-in belongs to.
 */
export async function addInternToProject(loginUid: string, projectId: string) {
  const db = adminDb();
  const [matches, project] = await Promise.all([
    db.collection("interns").where("loginUid", "==", loginUid).limit(1).get(),
    db.collection("projects").doc(projectId).get(),
  ]);
  const intern = matches.docs[0];
  if (!intern) throw new HttpError("This sign-in no longer has an intern record.", 409);
  if (intern.data().status !== "active") throw new HttpError("This internship is no longer active.", 409);
  if (!project.exists || projectApprovalStatus(project.data()!) !== "approved") {
    throw new HttpError("Approve this project before putting an intern on it.", 409);
  }
  await intern.ref.update({ projectIds: FieldValue.arrayUnion(projectId), updatedAt: FieldValue.serverTimestamp() });
  // Brings the intern's sign-in into the project roster, which is what their task access is read from.
  await syncProjectAssignments([projectId]);
  return { id: intern.id, fullName: String(intern.data().fullName ?? "Intern") };
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
