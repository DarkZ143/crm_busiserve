export type AccessRole = "super_admin" | "cto" | "product_manager" | "team_member";
export type WorkspaceArea = "admin" | "cto" | "product-manager" | "workspace";

const AREA_ROLES: Record<WorkspaceArea, AccessRole[]> = {
  admin: ["super_admin"],
  cto: ["super_admin", "cto"],
  "product-manager": ["super_admin", "product_manager"],
  workspace: ["super_admin", "team_member"],
};

export function canAccessArea(role: string, area: string) {
  return (AREA_ROLES[area as WorkspaceArea] ?? []).includes(role as AccessRole);
}

export function canReadCollection(role: AccessRole, collection: string) {
  if (role === "super_admin") return true;
  if (collection === "clients") return role === "cto" || role === "product_manager";
  if (collection === "projectRequests") return role === "cto" || role === "product_manager";
  if (["projects", "tasks", "milestones", "workReports", "notifications"].includes(collection)) return true;
  if (collection === "users" || collection === "auditLogs") return role === "cto";
  return false;
}

export function canReadRecord(
  role: AccessRole,
  uid: string,
  collection: string,
  record: Record<string, unknown>,
  scopedProjectIds?: ReadonlySet<string>,
) {
  if (role === "super_admin") return true;
  if (collection === "clients") return role === "cto" || role === "product_manager" && (record.createdBy === uid || record.assignedProductManager === uid);
  if (collection === "projectRequests") return role === "cto" && record.status !== "draft" || role === "product_manager" && (record.createdBy === uid || record.assignedProductManager === uid);
  if (collection === "projects") {
    if (role === "cto") return record.assignedCto === uid;
    if (role === "product_manager") return record.assignedProductManager === uid;
    return Array.isArray(record.assignedTeam) && record.assignedTeam.includes(uid);
  }
  if (collection === "tasks") {
    if (role === "team_member") return record.assigneeId === uid && Boolean(scopedProjectIds?.has(String(record.projectId)));
    return Boolean(scopedProjectIds?.has(String(record.projectId)));
  }
  if (collection === "workReports") {
    if (role === "team_member") return record.employeeId === uid;
    return Boolean(scopedProjectIds?.has(String(record.projectId)));
  }
  if (collection === "milestones") return Boolean(scopedProjectIds?.has(String(record.projectId)));
  if (collection === "notifications") return record.recipientUid === uid;
  if (collection === "auditLogs") return role === "cto" && record.actorUid === uid;
  if (collection === "users") return role === "cto" && record.role === "team_member";
  return false;
}

export function isPrivilegedRole(role: AccessRole) {
  return role === "super_admin" || role === "cto";
}
