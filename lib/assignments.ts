import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { createNotification } from "@/lib/data";
import { combineProjectMembers, directTeamOf, internSummary, stringArray, teamMemberSummary } from "@/lib/project-approval";

/**
 * Recomputes who is on each project from its direct assignments, its linked teams, and interns assigned to it.
 *
 * - assignedTeam (user IDs) drives what team members can see and which tasks and reports they can file, so team
 *   members get access to every project their team is linked to.
 * - assignedTeamMembers, assignedTeams, and assignedInterns are display summaries for the project's submitter,
 *   who cannot read the users, teams, or interns collections.
 *
 * Users who join or leave a project through this recompute are notified.
 */
export async function syncProjectAssignments(projectIds: Iterable<string>) {
  const db = adminDb();
  const ids = [...new Set([...projectIds].filter(Boolean))];
  for (const projectId of ids) {
    const ref = db.collection("projects").doc(projectId);
    const [project, teams, directInterns] = await Promise.all([
      ref.get(),
      db.collection("teams").where("projectIds", "array-contains", projectId).get(),
      db.collection("interns").where("projectIds", "array-contains", projectId).get(),
    ]);
    if (!project.exists) continue;
    const data = project.data()!;
    const direct = directTeamOf(data);
    const teamData = teams.docs.map((team) => team.data());
    const { userIds, teamInternIds } = combineProjectMembers(direct, teamData);
    const teamUserIds = new Set(teamData.flatMap((team) => stringArray(team.memberUids)));

    const userDocs = await Promise.all(userIds.map((uid) => db.collection("users").doc(uid).get()));
    // Direct assignments were validated when they were made. People added through a team must still be active team members.
    const members = userDocs.filter((doc) => doc.exists && (
      direct.includes(doc.id)
      || teamUserIds.has(doc.id) && doc.data()?.role === "team_member" && doc.data()?.accountStatus === "active"
    ));
    const internIds = [...new Set([...directInterns.docs.map((doc) => doc.id), ...teamInternIds])];
    const internDocs = await Promise.all(internIds.map((id) => db.collection("interns").doc(id).get()));

    const assignedTeam = members.map((doc) => doc.id);
    const previous = stringArray(data.assignedTeam);
    await ref.update({
      // Accounts that were deleted drop out; suspended direct members stay listed as chosen.
      directAssignedTeam: direct.filter((uid) => userDocs.some((doc) => doc.id === uid && doc.exists)),
      assignedTeam,
      assignedTeamMembers: members.map((doc) => teamMemberSummary(doc.id, doc.data())),
      assignedTeams: teams.docs.map((team) => ({ id: team.id, name: String(team.data().name ?? "Team") })),
      assignedInterns: internDocs.filter((doc) => doc.exists).map((doc) => internSummary(doc.id, doc.data())),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const name = String(data.name ?? "a project");
    for (const uid of assignedTeam.filter((value) => !previous.includes(value))) {
      void createNotification(uid, "New project assignment", `You have been assigned to ${name}.`, "/workspace/projects", "project_assignment").catch(() => undefined);
    }
    for (const uid of previous.filter((value) => !assignedTeam.includes(value))) {
      void createNotification(uid, "Project assignment updated", `You are no longer assigned to ${name}.`, "/workspace/projects", "project_unassigned").catch(() => undefined);
    }
  }
}

/**
 * Refreshes every project a user is on, directly or through a team, after their account changes
 * (suspended, reactivated, role changed, or deleted).
 */
export async function resyncProjectsForUser(uid: string, { removeFromTeams = false } = {}) {
  const db = adminDb();
  const [teams, onProjects, directProjects] = await Promise.all([
    db.collection("teams").where("memberUids", "array-contains", uid).get(),
    db.collection("projects").where("assignedTeam", "array-contains", uid).get(),
    db.collection("projects").where("directAssignedTeam", "array-contains", uid).get(),
  ]);
  if (removeFromTeams && !teams.empty) {
    const batch = db.batch();
    for (const team of teams.docs) batch.update(team.ref, { memberUids: FieldValue.arrayRemove(uid), updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
  }
  await syncProjectAssignments([
    ...teams.docs.flatMap((team) => stringArray(team.data().projectIds)),
    ...onProjects.docs.map((project) => project.id),
    ...directProjects.docs.map((project) => project.id),
  ]);
}

/** Projects linked to any of these teams. */
export async function projectIdsForTeams(teamIds: string[]) {
  const db = adminDb();
  const teams = await Promise.all([...new Set(teamIds)].map((id) => db.collection("teams").doc(id).get()));
  return [...new Set(teams.flatMap((team) => stringArray(team.data()?.projectIds)))];
}
