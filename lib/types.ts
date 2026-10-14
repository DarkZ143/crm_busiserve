export const ROLES = [
  "super_admin",
  "cto",
  "product_manager",
  "team_member",
] as const;

export type Role = (typeof ROLES)[number];
export type AccountStatus = "active" | "suspended";
export type ProjectStatus =
  | "draft"
  | "pending_approval"
  | "rejected"
  | "pending_cto_review"
  | "approved"
  | "planning"
  | "in_progress"
  | "on_hold"
  | "blocked"
  | "in_review"
  | "completed"
  | "cancelled"
  | "archived";
export type ReportStatus =
  | "submitted"
  | "under_review"
  | "changes_requested"
  | "accepted";

export interface SessionUser {
  uid: string;
  displayName: string;
  email: string;
  role: Role;
  accountStatus: AccountStatus;
  designation?: string;
}

export interface RecordData {
  id: string;
  [key: string]: unknown;
}

export interface TeamWorkSummary {
  uid: string;
  displayName: string;
  designation: string;
  accountStatus: AccountStatus;
  reportCount: number;
  hoursLogged: number;
}

export type CollectionName =
  | "clients"
  | "projects"
  | "projectRequests"
  | "tasks"
  | "milestones"
  | "workReports"
  | "notifications"
  | "auditLogs"
  | "users"
  | "interns"
  | "teams";
