export type AccessRole = "super_admin" | "cto" | "product_manager" | "team_member" | "intern";
export type WorkspaceArea = "admin" | "cto" | "product-manager" | "workspace";

const AREA_ROLES: Record<WorkspaceArea, AccessRole[]> = {
  admin: ["super_admin"],
  cto: ["super_admin", "cto"],
  "product-manager": ["super_admin", "product_manager"],
  workspace: ["super_admin", "team_member", "intern"],
};

/**
 * Roles that do assigned delivery work in the workspace area: they see only their own projects,
 * tasks, and work reports. Interns have the same scope as a team member.
 */
export function isWorkspaceMember(role: string) {
  return role === "team_member" || role === "intern";
}

export function canAccessArea(role: string, area: string) {
  return (AREA_ROLES[area as WorkspaceArea] ?? []).includes(role as AccessRole);
}

export function canReadCollection(role: AccessRole, collection: string) {
  if (role === "super_admin") return true;
  if (role === "intern") return collection === "projects" || collection === "tasks" || collection === "workReports";
  // A full-time employee also looks after the interns they took on, the tasks they gave them, and the
  // teams they are on themselves.
  if (role === "team_member") return collection === "projects" || collection === "workReports" || collection === "tasks" || collection === "interns" || collection === "teams";
  return collection === "clients" || collection === "projects";
}

export function canReadRecord(
  role: AccessRole,
  uid: string,
  collection: string,
  record: Record<string, unknown>,
  _scopedProjectIds?: ReadonlySet<string>,
) {
  if (role === "super_admin") return true;
  if (collection === "clients") {
    if (isWorkspaceMember(role)) return false;
    if (role === "cto") return record.createdBy === uid;
    if (role === "product_manager") return record.createdBy === uid || record.assignedProductManager === uid;
    return record.createdBy === uid;
  }
  if (collection === "projects") {
    // The person who submitted a project can always follow its approval and team assignment.
    if (record.createdBy === uid) return true;
    if (role === "cto") return record.assignedCto === uid;
    if (role === "product_manager") return record.assignedProductManager === uid;
    return Array.isArray(record.assignedTeam) && record.assignedTeam.includes(uid);
  }
  if (collection === "projectRequests") return role === "cto" && record.status !== "draft" || role === "product_manager" && (record.createdBy === uid || record.assignedProductManager === uid);
  if (collection === "tasks") {
    // An intern sees only what was given to them. Everyone else on a project sees its whole board, so a
    // task assigned by a Super Admin reaches the team member responsible for that project as well.
    if (role === "intern") return record.assigneeId === uid && Boolean(_scopedProjectIds?.has(String(record.projectId)));
    return Boolean(_scopedProjectIds?.has(String(record.projectId)));
  }
  if (collection === "workReports") {
    if (isWorkspaceMember(role)) return record.employeeId === uid;
    return Boolean(_scopedProjectIds?.has(String(record.projectId)));
  }
  // Every employee sees the intern roster so they can follow and assign work. Editing one is a separate
  // question, settled on the write by whether they took that intern on.
  if (collection === "interns") return role === "team_member";
  // Teams are visible to the people on them, so nobody reads another team's roster.
  if (collection === "teams") return role === "team_member" && Array.isArray(record.memberUids) && record.memberUids.includes(uid);
  if (collection === "milestones") return Boolean(_scopedProjectIds?.has(String(record.projectId)));
  if (collection === "notifications") return record.recipientUid === uid;
  if (collection === "auditLogs") return role === "cto" && record.actorUid === uid;
  if (collection === "users") return role === "cto" && record.role === "team_member";
  return false;
}

export function isPrivilegedRole(role: AccessRole) {
  return role === "super_admin";
}
