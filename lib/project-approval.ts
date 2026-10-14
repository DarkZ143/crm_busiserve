import type { Role } from "@/lib/types";

export type ProjectApprovalStatus = "pending" | "approved" | "rejected";

/**
 * Projects created before the submission workflow existed have no approvalStatus.
 * They were created directly by a Super Admin or CTO, so they count as approved.
 */
export function projectApprovalStatus(record: Record<string, unknown>): ProjectApprovalStatus {
  const value = record.approvalStatus;
  if (value === "pending" || value === "approved" || value === "rejected") return value;
  return "approved";
}

export function isProjectReviewable(record: Record<string, unknown>) {
  const status = projectApprovalStatus(record);
  return status === "pending" || status === "rejected";
}

export function projectsHrefForRole(role: Role | string | undefined) {
  if (role === "super_admin") return "/admin/projects";
  if (role === "cto") return "/cto/projects";
  if (role === "product_manager") return "/product-manager/projects";
  return "/workspace/projects";
}

export type ProjectTeamMember = { uid: string; displayName: string; designation: string };

/** Denormalized team details let a submitter see who was assigned without reading the users collection. */
export function teamMemberSummary(uid: string, profile: Record<string, unknown> | undefined): ProjectTeamMember {
  return {
    uid,
    displayName: String(profile?.displayName ?? uid),
    designation: String(profile?.designation ?? ""),
  };
}

export type ProjectInternSummary = { id: string; internId: string; fullName: string; role: string };
export type ProjectTeamSummary = { id: string; name: string };

/** Interns have no login, so projects carry a small display summary (never contact details). */
export function internSummary(id: string, intern: Record<string, unknown> | undefined): ProjectInternSummary {
  return {
    id,
    internId: String(intern?.internId ?? id),
    fullName: String(intern?.fullName ?? id),
    role: String(intern?.role ?? ""),
  };
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))] : [];
}

/**
 * People assigned to a project one by one, as opposed to through a team.
 * Projects saved before teams existed only have assignedTeam, and all of those were direct assignments.
 */
export function directTeamOf(project: Record<string, unknown>): string[] {
  return Array.isArray(project.directAssignedTeam) ? stringArray(project.directAssignedTeam) : stringArray(project.assignedTeam);
}

/** Final project membership: direct assignments plus the account members of every linked team, without duplicates. */
export function combineProjectMembers(direct: string[], teams: { memberUids?: unknown; internIds?: unknown }[]) {
  return {
    userIds: [...new Set([...direct, ...teams.flatMap((team) => stringArray(team.memberUids))])],
    teamInternIds: [...new Set(teams.flatMap((team) => stringArray(team.internIds)))],
  };
}

/** Project statuses that only exist while a submission is awaiting or has failed Super Admin review. */
export const SUBMISSION_PROJECT_STATUSES = ["pending_approval", "rejected"] as const;
