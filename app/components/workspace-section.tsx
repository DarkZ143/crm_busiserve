"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { Bell, Building2, Check, ChevronLeft, ChevronRight, ClipboardCheck, ClipboardList, Eye, FileClock, FolderKanban, GraduationCap, Pencil, UsersRound, ListTodo, Plus, Search, ShieldAlert, Trash2, UserPlus, X } from "lucide-react";
import { CompanySettings } from "@/app/components/company-settings";
import { directTeamOf, isProjectReviewable, projectApprovalStatus, type ProjectTeamMember } from "@/lib/project-approval";
import type { CollectionName, RecordData, Role, SessionUser, TeamWorkSummary } from "@/lib/types";

type Option = { value: string; label: string };
type Field = {
  name: string;
  label: string;
  type?: "text" | "email" | "password" | "number" | "date" | "textarea" | "select";
  required?: boolean;
  full?: boolean;
  options?: Option[];
  multiple?: boolean;
  min?: number;
  max?: number;
  placeholder?: string;
};
type Auxiliary = {
  clients: RecordData[];
  projects: RecordData[];
  tasks: RecordData[];
  users: RecordData[];
  requests: RecordData[];
  notifications: RecordData[];
  interns: RecordData[];
  teams: RecordData[];
};

const internStatusOptions: Option[] = [
  { value: "active", label: "Active" }, { value: "completed", label: "Internship completed" }, { value: "discontinued", label: "Discontinued" },
];

const statusOptions: Option[] = [
  { value: "draft", label: "Draft" }, { value: "active", label: "Active" }, { value: "archived", label: "Archived" },
];
const priorityOptions: Option[] = [
  { value: "low", label: "Low" }, { value: "normal", label: "Normal" }, { value: "high", label: "High" }, { value: "urgent", label: "Urgent" },
];
const projectStatusOptions: Option[] = [
  { value: "draft", label: "Draft" }, { value: "approved", label: "Approved" }, { value: "planning", label: "Planning" },
  { value: "in_progress", label: "In progress" }, { value: "on_hold", label: "On hold" }, { value: "blocked", label: "Blocked" },
  { value: "in_review", label: "In review" }, { value: "completed", label: "Completed" }, { value: "cancelled", label: "Cancelled" }, { value: "archived", label: "Archived" },
];

const columns: Partial<Record<CollectionName, { key: string; label: string; primary?: boolean }[]>> = {
  clients: [
    { key: "clientName", label: "Client", primary: true }, { key: "projectName", label: "Project" }, { key: "contactNumber", label: "Contact" }, { key: "companyName", label: "Company" },
    { key: "officialEmail", label: "Email" }, { key: "industry", label: "Industry" },
    { key: "approvalStatus", label: "Approval" }, { key: "approvalComments", label: "Review notes" }, { key: "status", label: "Status" },
  ],
  projects: [
    { key: "name", label: "Project", primary: true }, { key: "status", label: "Status" }, { key: "approvalStatus", label: "Approval" },
    { key: "assignedTeamMembers", label: "Assigned team" }, { key: "createdByName", label: "Submitted by" },
    { key: "priority", label: "Priority" }, { key: "expectedEndDate", label: "Expected end" }, { key: "progressPercentage", label: "Progress" },
  ],
  projectRequests: [
    { key: "projectName", label: "Request", primary: true }, { key: "clientName", label: "Client" },
    { key: "status", label: "Status" }, { key: "expectedDurationMonths", label: "Duration" }, { key: "createdAt", label: "Submitted" },
  ],
  tasks: [
    { key: "title", label: "Task", primary: true }, { key: "assigneeName", label: "Assigned to" }, { key: "status", label: "Status" },
    { key: "priority", label: "Priority" }, { key: "dueDate", label: "Due date" },
  ],
  milestones: [
    { key: "title", label: "Milestone", primary: true }, { key: "projectId", label: "Project" }, { key: "dueDate", label: "Due date" },
    { key: "status", label: "Status" }, { key: "sequence", label: "Order" },
  ],
  workReports: [
    { key: "workSummary", label: "Work report", primary: true }, { key: "employeeName", label: "Team member" }, { key: "workDate", label: "Work date" },
    { key: "timeSpentHours", label: "Hours" }, { key: "status", label: "Status" },
  ],
  users: [
    { key: "uid", label: "User ID" }, { key: "displayName", label: "Name", primary: true }, { key: "email", label: "Login email" }, { key: "role", label: "Role" },
    { key: "designation", label: "Designation" }, { key: "accountStatus", label: "Access" },
  ],
  auditLogs: [
    { key: "action", label: "Action", primary: true }, { key: "actorName", label: "Performed by" }, { key: "actorRole", label: "Role" },
    { key: "targetCollection", label: "Record type" }, { key: "createdAt", label: "Time" },
  ],
  interns: [
    { key: "internId", label: "Intern ID" }, { key: "fullName", label: "Name", primary: true }, { key: "role", label: "Role" },
    { key: "joiningDate", label: "Joined" }, { key: "derivedTeams", label: "Teams" }, { key: "derivedProjects", label: "Projects" }, { key: "status", label: "Status" },
  ],
  teams: [
    { key: "name", label: "Team", primary: true }, { key: "category", label: "Category" }, { key: "id", label: "Team ID" }, { key: "createdAt", label: "Creation date" },
    { key: "derivedMembers", label: "Employees" }, { key: "derivedInterns", label: "Interns" },
    { key: "derivedProjects", label: "Assigned projects" },
  ],
  notifications: [
    { key: "title", label: "Update", primary: true }, { key: "body", label: "Details" }, { key: "kind", label: "Type" }, { key: "createdAt", label: "Received" },
  ],
};

const employeeColumns = [
  { key: "uid", label: "Employee ID" }, { key: "displayName", label: "Full name", primary: true },
  { key: "email", label: "Work email" }, { key: "designation", label: "Designation" },
  { key: "createdAt", label: "Joined" }, { key: "accountStatus", label: "Access" },
];

function roleOptions(): Option[] {
  return [
    { value: "super_admin", label: "Super Admin" },
    { value: "cto", label: "CTO" },
    { value: "product_manager", label: "Product Manager" },
    { value: "team_member", label: "Team member" },
  ];
}

function fieldOptions(records: RecordData[], key: string, labelKey: string): Option[] {
  return records.map((record) => ({ value: record.id, label: String(record[labelKey] ?? record.displayName ?? record.name ?? record.id) }));
}

/** People can only be assigned to approved projects; submissions still awaiting review are left out. */
function assignableProjectOptions(projects: RecordData[]): Option[] {
  return fieldOptions(projects.filter((record) => projectApprovalStatus(record) === "approved" && !["completed", "cancelled", "archived"].includes(String(record.status))), "id", "name");
}

/**
 * Edit forms only offer assignable records (approved, open projects; active accounts). Anything already linked
 * that falls outside that set is added back with its state, so it stays selected and is only removed on purpose.
 */
function withExistingOptions(fields: Field[], record: RecordData, auxiliary: Auxiliary): Field[] {
  const lookups: Record<string, (id: string) => string> = {
    projectIds: (id) => {
      const project = auxiliary.projects.find((item) => item.id === id);
      return project ? `${String(project.name ?? id)} (${humanize(project.status)})` : "Unavailable project";
    },
    memberUids: (id) => {
      const user = auxiliary.users.find((item) => item.id === id);
      return user ? `${String(user.displayName ?? id)} (${user.accountStatus !== "active" ? humanize(user.accountStatus) : humanize(user.role)})` : "Removed account";
    },
    internIds: (id) => {
      const intern = auxiliary.interns.find((item) => item.id === id);
      return intern ? `${String(intern.fullName ?? id)} · ${String(intern.internId ?? id)} (${humanize(intern.status)})` : "Removed intern";
    },
  };
  lookups.assignedTeam = lookups.memberUids;
  return fields.map((field) => {
    const label = lookups[field.name];
    if (!field.multiple || !label) return field;
    const options = field.options ?? [];
    const sourceKey = field.name === "assignedTeam" ? undefined : field.name;
    const linked = field.name === "assignedTeam" ? directTeamOf(record) : idsOf(sourceKey ? record[sourceKey] : undefined);
    const missing = linked.filter((id) => !options.some((option) => option.value === id));
    return missing.length ? { ...field, options: [...options, ...missing.map((id) => ({ value: id, label: label(id) }))] } : field;
  });
}

function plainText(value: unknown) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function namesFor(ids: string[], records: RecordData[], label: (record: RecordData) => string) {
  return ids.map((id) => {
    const record = records.find((item) => item.id === id);
    return record ? label(record) : null;
  }).filter((name): name is string => Boolean(name));
}

/** Text for columns that are computed from related records rather than stored on the row. */
function derivedCell(collection: CollectionName | null, key: string, record: RecordData, auxiliary: Auxiliary): string | null {
  const projectName = (project: RecordData) => String(project.name ?? project.id);
  if (collection === "interns") {
    const teams = auxiliary.teams.filter((team) => idsOf(team.internIds).includes(record.id));
    if (key === "derivedTeams") return teams.map((team) => String(team.name ?? team.id)).join(", ") || "—";
    if (key === "derivedProjects") {
      const direct = namesFor(idsOf(record.projectIds), auxiliary.projects, projectName);
      const viaTeams = namesFor(teams.flatMap((team) => idsOf(team.projectIds)), auxiliary.projects, projectName).filter((name) => !direct.includes(name));
      return [...direct, ...[...new Set(viaTeams)].map((name) => `${name} (via team)`)].join(", ") || "—";
    }
  }
  if (collection === "teams") {
    if (key === "derivedMembers") return namesFor(idsOf(record.memberUids), auxiliary.users, (user) => String(user.displayName ?? user.id)).join(", ") || "—";
    if (key === "derivedInterns") return namesFor(idsOf(record.internIds), auxiliary.interns, (intern) => String(intern.fullName ?? intern.id)).join(", ") || "—";
    if (key === "derivedProjects") return namesFor(idsOf(record.projectIds), auxiliary.projects, projectName).join(", ") || "—";
  }
  return null;
}

function createFields(collection: CollectionName | null, role: Role, auxiliary: Auxiliary, uid = ""): Field[] {
  if (collection === "clients") return [
    { name: "clientName", label: "Client or organization name", required: true },
    { name: "contactNumber", label: "Contact number", required: true },
    { name: "projectName", label: "Project name", required: true, full: true },
    { name: "businessAddress", label: "Business address", required: true, full: true },
    { name: "contactPerson", label: "Contact person" },
    { name: "officialEmail", label: "Official email", type: "email" },
    { name: "companyName", label: "Company name" },
    { name: "industry", label: "Industry" },
    { name: "requirements", label: "Client requirements", type: "textarea", full: true },
    { name: "objectives", label: "Project objectives", type: "textarea", full: true },
    ...(role === "super_admin" ? [{ name: "internalNotes", label: "Internal notes", type: "textarea" as const, full: true }] : []),
    ...(role === "super_admin" ? [{ name: "assignedProductManager", label: "Product Manager", type: "select" as const, options: fieldOptions(auxiliary.users.filter((record) => record.role === "product_manager" && record.accountStatus === "active"), "id", "displayName") }] : []),
    ...(role === "super_admin" ? [{ name: "status", label: "Client status", type: "select" as const, options: statusOptions }] : []),
  ];
  if (collection === "projectRequests") return [
    { name: "clientId", label: "Client", type: "select", required: true, options: fieldOptions(auxiliary.clients, "id", "clientName") },
    { name: "projectName", label: "Proposed project name", required: true },
    { name: "projectDescription", label: "Project overview", type: "textarea", full: true },
    { name: "requirements", label: "Requirements", type: "textarea", required: true, full: true },
    { name: "objectives", label: "Business objectives", type: "textarea", full: true },
    { name: "expectedDurationMonths", label: "Expected duration (months)", type: "number", required: true, min: 1, max: 120 },
    { name: "expectedEndDate", label: "Target end date", type: "date" },
    { name: "proposedPrice", label: "Proposed price", type: "number", min: 0 },
    { name: "currency", label: "Currency code", placeholder: "INR" },
    { name: "status", label: "Request stage", type: "select", required: true, options: [{ value: "draft", label: "Save as draft" }, { value: "pending_cto_review", label: "Submit for CTO review" }] },
  ];
  if (collection === "projects" && role !== "super_admin") return [
    { name: "name", label: "Project name", required: true },
    { name: "category", label: "Project category" },
    { name: "clientId", label: "Client (optional)", type: "select", options: fieldOptions(auxiliary.clients.filter((record) => clientApproval(record) === "approved"), "id", "clientName") },
    { name: "priority", label: "Priority", type: "select", options: priorityOptions },
    { name: "description", label: "Project description", type: "textarea", required: true, full: true },
    { name: "scopeOfWork", label: "Scope of work", type: "textarea", full: true },
    { name: "requirements", label: "Requirements", type: "textarea", full: true },
    { name: "deliverables", label: "Deliverables", type: "textarea", full: true },
    { name: "startDate", label: "Proposed start date", type: "date" },
    { name: "expectedEndDate", label: "Expected end date", type: "date" },
    { name: "durationMonths", label: "Expected duration (months)", type: "number", min: 1, max: 120 },
  ];
  if (collection === "projects") return [
    { name: "clientId", label: "Client", type: "select", required: true, options: fieldOptions(auxiliary.clients, "id", "clientName") },
    { name: "projectRequestId", label: "Approved request (optional)", type: "select", options: [{ value: "", label: "No linked request" }, ...fieldOptions(auxiliary.requests.filter((record) => record.status === "approved" && !record.projectId), "id", "projectName")] },
    { name: "name", label: "Project name", required: true },
    { name: "category", label: "Project category" },
    { name: "description", label: "Project description", type: "textarea", full: true },
    { name: "scopeOfWork", label: "Scope of work", type: "textarea", full: true },
    { name: "requirements", label: "Requirements", type: "textarea", full: true },
    { name: "deliverables", label: "Deliverables", type: "textarea", full: true },
    ...(role === "super_admin" ? [{ name: "assignedCto", label: "Assigned CTO", type: "select" as const, required: true, options: fieldOptions(auxiliary.users.filter((record) => record.role === "cto" && record.accountStatus === "active"), "id", "displayName") }] : []),
    { name: "assignedTeam", label: "Assigned team members", type: "select", multiple: true, options: fieldOptions(auxiliary.users.filter((record) => record.role === "team_member" && record.accountStatus === "active"), "id", "displayName") },
    { name: "teamIds", label: "Assign teams", type: "select", multiple: true, options: fieldOptions(auxiliary.teams, "id", "name") },
    { name: "contractPrice", label: "Contract price", type: "number", min: 0 },
    { name: "currency", label: "Currency code", placeholder: "INR" },
    { name: "startDate", label: "Start date", type: "date" },
    { name: "expectedEndDate", label: "Expected end date", type: "date" },
    { name: "durationMonths", label: "Agreed duration (months)", type: "number", min: 1, max: 120 },
    { name: "priority", label: "Priority", type: "select", options: priorityOptions },
  ];
  if (collection === "interns") return [
    { name: "internId", label: "Intern ID", required: true, placeholder: "e.g. BUS-INT-014" },
    { name: "fullName", label: "Full name", required: true },
    { name: "role", label: "Internship role", required: true, placeholder: "Frontend developer, UI designer, QA…" },
    { name: "joiningDate", label: "Joining date", type: "date", required: true },
    { name: "endDate", label: "Internship end date", type: "date" },
    { name: "status", label: "Status", type: "select", options: internStatusOptions },
    { name: "email", label: "Email", type: "email" },
    { name: "phone", label: "Phone number" },
    { name: "college", label: "College or institute", full: true },
    { name: "projectIds", label: "Assign projects", type: "select", multiple: true, full: true, options: assignableProjectOptions(auxiliary.projects) },
    { name: "notes", label: "Notes", type: "textarea", full: true },
  ];
  if (collection === "teams") return [
    { name: "name", label: "Team name", required: true, placeholder: "e.g. Web Squad A" },
    { name: "category", label: "Team category", required: true, placeholder: "e.g. Engineering, Design, Operations" },
    { name: "description", label: "What this team works on", type: "textarea", full: true },
    { name: "memberUids", label: "Team members (accounts)", type: "select", multiple: true, options: fieldOptions(auxiliary.users.filter((record) => record.role === "team_member" && record.accountStatus === "active"), "id", "displayName") },
    { name: "internIds", label: "Interns", type: "select", multiple: true, options: auxiliary.interns.filter((record) => record.status !== "discontinued").map((record) => ({ value: record.id, label: `${String(record.fullName ?? record.id)} · ${String(record.internId ?? record.id)}` })) },
    { name: "projectIds", label: "Assign to projects", type: "select", multiple: true, full: true, options: assignableProjectOptions(auxiliary.projects) },
  ];
  if (collection === "tasks") return [
    { name: "projectId", label: "Project", type: "select", required: true, options: fieldOptions(auxiliary.projects, "id", "name") },
    { name: "assigneeId", label: "Team member", type: "select", required: true, options: fieldOptions(auxiliary.users.filter((record) => record.role === "team_member" && record.accountStatus === "active"), "id", "displayName") },
    { name: "title", label: "Task title", required: true },
    { name: "priority", label: "Priority", type: "select", options: priorityOptions },
    { name: "dueDate", label: "Due date", type: "date" },
    { name: "description", label: "Task details", type: "textarea", full: true },
  ];
  if (collection === "milestones") return [
    { name: "projectId", label: "Project", type: "select", required: true, options: fieldOptions(auxiliary.projects, "id", "name") },
    { name: "title", label: "Milestone name", required: true },
    { name: "dueDate", label: "Target date", type: "date", required: true },
    { name: "sequence", label: "Order", type: "number", min: 1 },
    { name: "description", label: "Milestone details", type: "textarea", full: true },
  ];
  if (collection === "workReports") return [
    { name: "projectId", label: "Project", type: "select", required: true, options: fieldOptions(auxiliary.projects.filter((project) => role !== "team_member" || Array.isArray(project.assignedTeam) && project.assignedTeam.includes(uid)), "id", "name") },
    ...(auxiliary.tasks.length ? [{ name: "taskId", label: "Task (optional)", type: "select" as const, options: [{ value: "", label: "Project update" }, ...fieldOptions(auxiliary.tasks, "id", "title")] }] : []),
    { name: "workDate", label: "Work date", type: "date", required: true },
    { name: "timeSpentHours", label: "Hours spent", type: "number", required: true, min: 0, max: 24 },
    { name: "workSummary", label: "Short summary", required: true, full: true },
    { name: "description", label: "Completed work", type: "textarea", required: true, full: true },
    { name: "tasksCompleted", label: "Tasks completed", type: "textarea", full: true },
    { name: "workInProgress", label: "Work in progress", type: "textarea", full: true },
    { name: "nextSteps", label: "Planned next steps", type: "textarea", full: true },
    { name: "blockers", label: "Blockers or issues", type: "textarea", full: true },
  ];
  if (collection === "users") return [
    { name: "uid", label: "User ID", required: true, placeholder: "e.g. BUS-EMP-014" },
    { name: "displayName", label: "Full name", required: true },
    { name: "email", label: "Login ID (work email)", type: "email", required: true },
    { name: "password", label: "Initial password", type: "password", required: true, full: true, placeholder: "At least 12 characters" },
    { name: "role", label: "Role", type: "select", required: true, options: roleOptions() },
    { name: "designation", label: "Team designation", placeholder: "Developer, Designer, QA…" },
  ];
  return [];
}

function clientApproval(record: RecordData) {
  return String(record.approvalStatus ?? (record.status === "draft" ? "pending" : "approved"));
}

function recordApproval(collection: CollectionName | null, record: RecordData) {
  return collection === "projects" ? projectApprovalStatus(record) : clientApproval(record);
}

function teamMembers(record: RecordData): ProjectTeamMember[] {
  if (Array.isArray(record.assignedTeamMembers)) {
    return record.assignedTeamMembers
      .filter((member): member is Record<string, unknown> => Boolean(member) && typeof member === "object")
      .map((member) => ({ uid: String(member.uid ?? ""), displayName: String(member.displayName ?? member.uid ?? "Team member"), designation: String(member.designation ?? "") }));
  }
  // Older projects only stored user IDs.
  return Array.isArray(record.assignedTeam) ? record.assignedTeam.map((uid) => ({ uid: String(uid), displayName: String(uid), designation: "" })) : [];
}

function projectTeams(record: RecordData): { id: string; name: string }[] {
  return Array.isArray(record.assignedTeams)
    ? record.assignedTeams.filter((team): team is Record<string, unknown> => Boolean(team) && typeof team === "object").map((team) => ({ id: String(team.id ?? ""), name: String(team.name ?? "Team") }))
    : [];
}

function projectInterns(record: RecordData): { id: string; internId: string; fullName: string; role: string }[] {
  return Array.isArray(record.assignedInterns)
    ? record.assignedInterns.filter((intern): intern is Record<string, unknown> => Boolean(intern) && typeof intern === "object").map((intern) => ({ id: String(intern.id ?? ""), internId: String(intern.internId ?? ""), fullName: String(intern.fullName ?? "Intern"), role: String(intern.role ?? "") }))
    : [];
}

function teamSummary(record: RecordData) {
  const teams = projectTeams(record).map((team) => `${team.name} team`);
  const people = [...teamMembers(record).map((member) => member.displayName), ...projectInterns(record).map((intern) => `${intern.fullName} (intern)`)];
  if (teams.length || people.length) return [...teams, ...people].join(", ");
  return projectApprovalStatus(record) === "pending" ? "Awaiting assignment" : "—";
}

function humanize(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "object") return "—";
  return String(value).replaceAll("_", " ");
}

function isDateField(name: string) {
  return name.endsWith("Date") || name.endsWith("At");
}

function dateDisplay(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? humanize(value) : new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function emptyMessage(collection: CollectionName | null, section: string) {
  if (collection === "clients") return "Client submissions and their approval decisions will appear here.";
  if (collection === "projects") return "Projects you submit or are assigned to will appear here, with their approval status and team.";
  if (collection === "projectRequests") return "Project requests and review decisions will appear here.";
  if (collection === "tasks") return "Tasks assigned to your project teams will appear here.";
  if (collection === "workReports") return "Daily reports and review history will appear here.";
  if (collection === "users" && section === "employees") return "Add full-time employees to create workspace accounts and make them available to teams.";
  if (collection === "users") return "Authorized workspace accounts will appear here.";
  if (collection === "interns") return "Add interns who have joined the company to give them an ID, role, and projects.";
  if (collection === "teams") return "Create teams by category, then manage employee and intern membership under each team.";
  if (collection === "auditLogs") return "Sensitive administrative actions will be recorded here.";
  if (collection === "notifications") return "You’re up to date. New relevant project activity will appear here.";
  if (section === "settings") return "Company preferences will appear here after they are configured.";
  if (section === "milestones") return "Project milestones will appear here after they are added to a project.";
  return "Records for this area will appear here as work moves through the company.";
}

function createSchema(fields: Field[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    let value: z.ZodType;
    if (field.multiple) value = z.array(z.string());
    else if (field.type === "number" && field.required) value = z.coerce.number().min(field.min ?? 0);
    else if (field.type === "number") value = z.preprocess((input) => input === "" ? undefined : input, z.coerce.number().optional());
    else if (field.name === "password") value = z.string().min(12, "Use at least 12 characters.").max(128);
    else if (field.required) value = z.string().trim().min(1, `${field.label} is required.`);
    else value = z.string().optional();
    shape[field.name] = value;
  }
  return z.object(shape);
}

function RecordForm({
  fields,
  title,
  description,
  endpoint,
  method = "POST",
  extraPayload,
  initialValues,
  sendClearedFields = false,
  onClose,
  onSuccess,
}: {
  fields: Field[];
  title: string;
  description: string;
  endpoint: string;
  method?: "POST" | "PATCH";
  extraPayload?: Record<string, unknown>;
  initialValues?: Record<string, unknown>;
  /** On edit, send "" for fields the user emptied so the server clears them. */
  sendClearedFields?: boolean;
  onClose: () => void;
  onSuccess: (record: Record<string, unknown>) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const schema = useMemo(() => createSchema(fields), [fields]);
  const form = useForm<Record<string, unknown>>({
    resolver: zodResolver(schema),
    defaultValues: {
      ...Object.fromEntries(fields.map((field) => [field.name, field.multiple ? [] : ""])),
      ...(method === "POST" && fields.some((field) => field.name === "workDate") ? { workDate: new Date().toISOString().slice(0, 10) } : {}),
      ...(initialValues ?? {}),
    },
  });

  async function save(values: Record<string, unknown>) {
    setPending(true);
    setError("");
    const clean = Object.fromEntries(Object.entries(values).filter(([key, value]) => {
      if (value === undefined) return false;
      if (value !== "") return true;
      const previous = initialValues?.[key];
      return sendClearedFields && previous !== undefined && previous !== null && previous !== "";
    }));
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...clean, ...extraPayload }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "The record could not be saved.");
      onSuccess((result.record ?? {}) as Record<string, unknown>);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The record could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" data-lenis-prevent onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header"><div><h2>{title}</h2><p>{description}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog"><X size={17} /></button></header>
        <form className="record-form" onSubmit={form.handleSubmit(save)}>
          {fields.map((field) => (
            <div className={`form-field ${field.full ? "full" : ""}`} key={field.name}>
              <label htmlFor={`field-${field.name}`}>{field.label}{field.required ? " *" : ""}</label>
              {field.type === "textarea" ? (
                <textarea className="textarea-input" id={`field-${field.name}`} placeholder={field.placeholder} maxLength={8000} {...form.register(field.name)} />
              ) : field.type === "select" ? (
                <select className="select-input" id={`field-${field.name}`} multiple={field.multiple} {...form.register(field.name)}>
                  {!field.multiple && <option value="">Select an option</option>}
                  {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : (
                <input className="text-input" id={`field-${field.name}`} type={field.type ?? "text"} placeholder={field.placeholder} min={field.min} max={field.max} minLength={field.name === "password" ? 12 : undefined} maxLength={field.name === "password" ? 128 : field.type === "number" ? undefined : 500} autoComplete={field.name === "password" ? "new-password" : undefined} {...form.register(field.name)} />
              )}
              {form.formState.errors[field.name] && <span className="form-field-error">{String(form.formState.errors[field.name]?.message ?? "Check this field.")}</span>}
            </div>
          ))}
          {error && <div className="form-error-inline" role="alert">{error}</div>}
          <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={pending}>{pending ? "Saving…" : method === "PATCH" ? "Save changes" : "Save record"}</button></div>
        </form>
      </section>
    </div>
  );
}

function ReviewDialog({
  collection,
  record,
  users,
  teams = [],
  onClose,
  onComplete,
}: {
  collection: CollectionName;
  record: RecordData;
  users: RecordData[];
  teams?: RecordData[];
  onClose: () => void;
  onComplete: () => void;
}) {
  const requestKind = collection === "projectRequests";
  const clientKind = collection === "clients";
  const projectKind = collection === "projects";
  const currentManager = users.find((user) => user.id === record.assignedProductManager && user.role === "product_manager" && user.accountStatus === "active");
  const activeTeamMembers = users.filter((user) => user.role === "team_member" && user.accountStatus === "active");
  const activeCtos = users.filter((user) => user.role === "cto" && user.accountStatus === "active");
  const [action, setAction] = useState(requestKind || clientKind || projectKind ? "approve" : "accepted");
  // A re-review of a rejected project starts with a blank note so the old rejection reason is not saved as the approval note.
  const [comments, setComments] = useState(projectKind ? "" : String(record.approvalComments ?? ""));
  const [assignedProductManager, setAssignedProductManager] = useState(String(currentManager?.id ?? ""));
  const [team, setTeam] = useState<string[]>(() => teamMembers(record).map((member) => member.uid).filter((uid) => activeTeamMembers.some((user) => user.id === uid)));
  const [teamIds, setTeamIds] = useState<string[]>(() => projectTeams(record).map((team) => team.id).filter((id) => teams.some((item) => item.id === id)));
  const [assignedCto, setAssignedCto] = useState(() => activeCtos.some((user) => user.id === record.assignedCto) ? String(record.assignedCto) : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function toggleTeamMember(uid: string, selected: boolean) {
    setTeam((current) => selected ? [...new Set([...current, uid])] : current.filter((value) => value !== uid));
  }

  async function submit() {
    if (projectKind && action === "approve" && !team.length && !teamIds.length) {
      setError("Select at least one team or team member before approving this project.");
      return;
    }
    if (projectKind && action === "reject" && !comments.trim()) {
      setError("Add a comment so the submitter knows why the project was not approved.");
      return;
    }
    setPending(true);
    setError("");
    try {
      const body = requestKind
        ? { action, reviewerComments: comments }
        : clientKind
          ? { operation: "review", action, assignedProductManager, reviewerComments: comments }
          : projectKind
            ? { operation: "review", action, assignedTeam: action === "approve" ? team : [], teamIds: action === "approve" ? teamIds : [], assignedCto: action === "approve" ? assignedCto : "", reviewerComments: comments }
            : { operation: "review", status: action, reviewerComments: comments };
      const response = await fetch(`/api/records/${collection}/${record.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "This review could not be saved.");
      onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This review could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" data-lenis-prevent>
      <section className="modal-card" role="dialog" aria-modal="true" aria-label="Review record">
        <header className="modal-header"><div><h2>{requestKind ? "Review project request" : clientKind ? "Review client submission" : projectKind ? "Review project submission" : "Review work report"}</h2><p>{projectKind ? `${String(record.name ?? "Project")}${record.createdByName ? ` · submitted by ${String(record.createdByName)}` : ""}` : String(record.clientName ?? record.projectName ?? record.workSummary ?? "Record")}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog"><X size={17} /></button></header>
        <div className="review-form">
          {projectKind && <ProjectSummary record={record} />}
          {projectKind && projectApprovalStatus(record) === "rejected" && record.approvalComments ? <p className="form-note">Previous rejection note: “{String(record.approvalComments)}”</p> : null}
          <label className="field-label" htmlFor="review-decision">Decision</label>
          <select className="select-input" id="review-decision" value={action} onChange={(event) => { setAction(event.target.value); setError(""); }}>
            {requestKind ? <><option value="approve">Approve</option><option value="request_changes">Request changes</option><option value="reject">Reject</option></> : clientKind ? <><option value="approve">Approve client</option><option value="reject">Reject client</option></> : projectKind ? <><option value="approve">Approve and assign team</option><option value="reject">Reject project</option></> : <><option value="accepted">Accept report</option><option value="under_review">Keep under review</option><option value="changes_requested">Request corrections</option></>}
          </select>
          {projectKind && action === "approve" && <>
            <fieldset className="checkbox-fieldset">
              <legend className="field-label">Assign teams</legend>
              {teams.length ? <div className="checkbox-list">
                {teams.map((item) => {
                  const size = idsOf(item.memberUids).length + idsOf(item.internIds).length;
                  return <label className="checkbox-option" key={item.id}>
                    <input type="checkbox" checked={teamIds.includes(item.id)} onChange={(event) => setTeamIds((current) => event.target.checked ? [...new Set([...current, item.id])] : current.filter((value) => value !== item.id))} />
                    <span>{String(item.name ?? item.id)}<small>{size} {size === 1 ? "person" : "people"}</small></span>
                  </label>;
                })}
              </div> : <p className="form-note">No teams yet. Create teams from the Interns tab, or pick people below.</p>}
            </fieldset>
            <fieldset className="checkbox-fieldset">
              <legend className="field-label">Assign individual team members</legend>
              {activeTeamMembers.length ? <div className="checkbox-list">
                {activeTeamMembers.map((member) => <label className="checkbox-option" key={member.id}>
                  <input type="checkbox" checked={team.includes(member.id)} onChange={(event) => toggleTeamMember(member.id, event.target.checked)} />
                  <span>{String(member.displayName ?? member.id)}{member.designation ? <small>{String(member.designation)}</small> : null}</span>
                </label>)}
              </div> : <p className="form-note">No active team member accounts are available.</p>}
              <p className="form-note">Pick at least one team or one person. Everyone in a selected team is added to the project.</p>
            </fieldset>
            <label className="field-label" htmlFor="project-cto">Lead CTO (optional)</label>
            <select className="select-input" id="project-cto" value={assignedCto} onChange={(event) => setAssignedCto(event.target.value)}>
              <option value="">No CTO assigned</option>
              {activeCtos.map((user) => <option value={String(user.id)} key={user.id}>{String(user.displayName ?? user.id)}</option>)}
            </select>
          </>}
          {clientKind && action === "approve" && <>
            <label className="field-label" htmlFor="client-product-manager">Product Manager (optional)</label>
            <select className="select-input" id="client-product-manager" value={assignedProductManager} onChange={(event) => setAssignedProductManager(event.target.value)}>
              <option value="">No Product Manager assigned</option>
              {users.filter((user) => user.role === "product_manager" && user.accountStatus === "active").map((user) => <option value={String(user.id)} key={user.id}>{String(user.displayName ?? user.id)}</option>)}
            </select>
          </>}
          <label className="field-label" htmlFor="review-comments">Comments for the submitter{projectKind && action === "reject" ? " *" : ""}</label>
          <textarea className="textarea-input" id="review-comments" value={comments} onChange={(event) => setComments(event.target.value)} maxLength={4000} placeholder="Add context or requested changes" />
          {error && <div className="form-error-inline" role="alert">{error}</div>}
          <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="button" onClick={submit} disabled={pending}>{pending ? "Saving…" : "Save decision"}</button></div>
        </div>
      </section>
    </div>
  );
}

function ProjectSummary({ record }: { record: RecordData }) {
  const facts = [
    { label: "Client", value: record.clientName },
    { label: "Category", value: record.category },
    { label: "Priority", value: record.priority },
    { label: "Proposed start", value: record.startDate ? dateDisplay(record.startDate) : "" },
    { label: "Expected end", value: record.expectedEndDate ? dateDisplay(record.expectedEndDate) : "" },
    { label: "Duration", value: record.durationMonths ? `${humanize(record.durationMonths)} months` : "" },
  ].filter((fact) => fact.value);
  const sections = [
    { label: "Description", value: record.description },
    { label: "Scope of work", value: record.scopeOfWork },
    { label: "Requirements", value: record.requirements },
    { label: "Deliverables", value: record.deliverables },
  ].filter((section) => typeof section.value === "string" && section.value.trim());
  if (!facts.length && !sections.length) return null;
  return (
    <div className="project-summary">
      {facts.length > 0 && <dl className="detail-grid">{facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{humanize(fact.value)}</dd></div>)}</dl>}
      {sections.map((section) => <div className="detail-block" key={section.label}><h3>{section.label}</h3><p>{String(section.value)}</p></div>)}
    </div>
  );
}

function ProjectDetailsDialog({ record, onClose }: { record: RecordData; onClose: () => void }) {
  const approval = projectApprovalStatus(record);
  const members = teamMembers(record);
  const teams = projectTeams(record);
  const interns = projectInterns(record);
  const reviewer = record.reviewedByName ? String(record.reviewedByName) : "";
  return (
    <div className="modal-backdrop" role="presentation" data-lenis-prevent onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="project-details-title">
        <header className="modal-header">
          <div><h2 id="project-details-title">{String(record.name ?? "Project")}</h2><p>{String(record.projectId ?? "")}</p></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog"><X size={17} /></button>
        </header>
        <div className="review-form">
          <div className={`approval-banner approval-${approval}`} role="status">
            <strong>{approval === "approved" ? "Approved" : approval === "rejected" ? "Not approved" : "Pending Super Admin approval"}</strong>
            <span>
              {approval === "approved"
                ? reviewer ? `Approved by ${reviewer}${record.reviewedAt ? ` on ${dateDisplay(record.reviewedAt)}` : ""}.` : "This project is active."
                : approval === "rejected"
                  ? `Reviewed by ${reviewer || "a Super Admin"}${record.reviewedAt ? ` on ${dateDisplay(record.reviewedAt)}` : ""}.`
                  : "A Super Admin will review this project and assign a team."}
            </span>
            {record.approvalComments ? <p>“{String(record.approvalComments)}”</p> : null}
          </div>
          <dl className="detail-grid">
            <div><dt>Status</dt><dd><span className={`status-badge status-${String(record.status ?? "unknown")}`}>{humanize(record.status)}</span></dd></div>
            <div><dt>Submitted by</dt><dd>{humanize(record.createdByName)}{record.createdAt ? ` · ${dateDisplay(record.createdAt)}` : ""}</dd></div>
            <div><dt>Lead CTO</dt><dd>{humanize(record.assignedCtoName)}</dd></div>
            <div><dt>Progress</dt><dd>{typeof record.progressPercentage === "number" ? `${record.progressPercentage}%` : "—"}</dd></div>
          </dl>
          <div className="detail-block">
            <h3>Assigned team</h3>
            {members.length ? <ul className="team-list">{members.map((member) => <li key={member.uid}><span className="avatar avatar-small" aria-hidden="true">{member.displayName.trim().slice(0, 1).toUpperCase() || "T"}</span><span><strong>{member.displayName}</strong>{member.designation ? <small>{member.designation}</small> : null}</span></li>)}</ul>
              : <p>{approval === "pending" ? "The team will appear here once a Super Admin approves the project." : "No team members are assigned."}</p>}
          </div>
          {teams.length > 0 && <div className="detail-block">
            <h3>Teams</h3>
            <p>{teams.map((team) => team.name).join(", ")}</p>
          </div>}
          {interns.length > 0 && <div className="detail-block">
            <h3>Interns</h3>
            <ul className="team-list">{interns.map((intern) => <li key={intern.id}><span className="avatar avatar-small" aria-hidden="true">{intern.fullName.trim().slice(0, 1).toUpperCase() || "I"}</span><span><strong>{intern.fullName}</strong><small>{[intern.role, intern.internId].filter(Boolean).join(" · ")}</small></span></li>)}</ul>
          </div>}
          <ProjectSummary record={record} />
          <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Close</button></div>
        </div>
      </section>
    </div>
  );
}

export function WorkspaceSection({
  user,
  section,
  collection,
  records,
  auxiliary,
  companyDate,
  teamWorkSummary = [],
  initialNewRecord = false,
}: {
  user: SessionUser;
  section: string;
  collection: CollectionName | null;
  records: RecordData[];
  auxiliary: Auxiliary;
  companyDate: string;
  teamWorkSummary?: TeamWorkSummary[];
  initialNewRecord?: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [formOpen, setFormOpen] = useState(initialNewRecord);
  const [editRecord, setEditRecord] = useState<RecordData | null>(null);
  const [reviewRecord, setReviewRecord] = useState<RecordData | null>(null);
  const [detailRecord, setDetailRecord] = useState<RecordData | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RecordData | null>(null);
  const [deleteStage, setDeleteStage] = useState<"confirm" | "password">("confirm");
  const [deletePassword, setDeletePassword] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [manageTeam, setManageTeam] = useState<RecordData | null>(null);
  const [employeeToAdd, setEmployeeToAdd] = useState("");
  const [internToAdd, setInternToAdd] = useState("");
  const [createdUser, setCreatedUser] = useState<Record<string, unknown> | null>(null);
  const [rowPending, setRowPending] = useState("");
  const [rowError, setRowError] = useState("");
  const fields = collection === "users" && section === "employees"
    ? createFields(collection, user.role, auxiliary, user.uid).filter((field) => field.name !== "role").map((field) => field.name === "uid" ? { ...field, label: "Employee ID" } : field)
    : createFields(collection, user.role, auxiliary, user.uid);
  const canCreate = Boolean(collection && fields.length && (
    collection === "clients" ||
    collection === "projects" ||
    collection === "projectRequests" && (user.role === "super_admin" || user.role === "product_manager") ||
    (collection === "tasks" || collection === "milestones") && user.role === "super_admin" ||
    collection === "workReports" && user.role === "team_member" ||
    collection === "users" && user.role === "super_admin" ||
    (collection === "interns" || collection === "teams") && user.role === "super_admin"
  ));
  const currentColumns = useMemo(() => section === "employees" ? employeeColumns : collection ? columns[collection] ?? [] : [], [collection, section]);
  const filtered = useMemo(() => records.filter((record) => {
    const searchable = [
      ...Object.values(record).map((value) => String(value ?? "")),
      collection === "projects" ? teamSummary(record) : "",
      ...currentColumns.map((column) => derivedCell(collection, column.key, record, auxiliary) ?? ""),
    ];
    const matchesQuery = !query || searchable.some((value) => value.toLowerCase().includes(query.toLowerCase()));
    const recordStatus = collection === "teams"
      ? String(record.category ?? "General")
      : collection === "clients"
      ? String(record.approvalStatus ?? (record.status === "draft" ? "pending" : "approved"))
      : String(record.status ?? record.accountStatus ?? "");
    const matchesStatus = statusFilter === "all" || recordStatus === statusFilter;
    return matchesQuery && matchesStatus;
  }), [records, query, statusFilter, collection, currentColumns, auxiliary]);
  const pageSize = 20;
  const pages = Math.ceil(filtered.length / pageSize);
  const pageRecords = filtered.slice(page * pageSize, (page + 1) * pageSize);

  async function patchRecord(id: string, targetCollection: CollectionName, body: Record<string, unknown>) {
    setRowPending(id);
    setRowError("");
    try {
      const response = await fetch(`/api/records/${targetCollection}/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "The update could not be saved.");
      router.refresh();
      return result.record as Record<string, unknown> | undefined;
    } catch (reason) {
      setRowError(reason instanceof Error ? reason.message : "The update could not be saved.");
    } finally {
      setRowPending("");
    }
    return undefined;
  }

  async function changeTeamMembership(kind: "employee" | "intern", memberId: string, action: "add" | "remove") {
    if (!manageTeam || !memberId) return;
    const key = kind === "employee" ? "memberUids" : "internIds";
    const existing = idsOf(manageTeam[key]);
    const next = action === "add" ? [...new Set([...existing, memberId])] : existing.filter((id) => id !== memberId);
    const updated = await patchRecord(manageTeam.id, "teams", { [key]: next });
    if (!updated) return;
    setManageTeam((current) => current?.id === manageTeam.id ? { ...current, ...updated, [key]: next } : current);
    if (kind === "employee") setEmployeeToAdd("");
    else setInternToAdd("");
  }

  function formSucceeded(record: Record<string, unknown>) {
    if (collection === "users" && typeof record.uid === "string") setCreatedUser(record);
    setFormOpen(false);
    setEditRecord(null);
    router.refresh();
  }

  function closeDeleteDialog() {
    if (deletePending) return;
    setDeleteTarget(null);
    setDeleteStage("confirm");
    setDeletePassword("");
    setDeleteError("");
  }

  async function confirmTeamMemberDelete() {
    if (!deleteTarget) return;
    if (deleteStage === "confirm") {
      setDeleteError("");
      setDeleteStage("password");
      return;
    }
    setDeletePending(true);
    setDeleteError("");
    try {
      const response = await fetch(`/api/records/users/${deleteTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "delete", password: deletePassword }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "The team member could not be deleted.");
      setDeleteTarget(null);
      setDeleteStage("confirm");
      setDeletePassword("");
      router.refresh();
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : "The team member could not be deleted.");
    } finally {
      setDeletePending(false);
    }
  }

  const canReview = user.role === "super_admin" || user.role === "cto";
  const heading = section === "updates" ? "Project updates" : section === "history" ? "Previous work reports" : section === "milestones" ? "Milestones" : section === "settings" ? user.role === "team_member" ? "My account" : "Company preferences" : "";

  return (
    <>
      {createdUser && <div className="invite-result"><div><strong>{section === "employees" ? "Employee account created" : "User account created"}</strong><span>Share the initial password securely. Passwords are not shown or saved in the user profile.</span><code>User ID: {String(createdUser.uid)} · Login: {String(createdUser.email)}</code></div><button className="icon-button" type="button" aria-label="Dismiss account details" onClick={() => setCreatedUser(null)}><X size={15} /></button></div>}
      {heading && <p className="section-description">{heading === "Company preferences" ? "Manage the workspace timezone and operational defaults." : heading === "My account" ? "Review your employee details and manage your sign-in." : heading === "Milestones" ? "Milestones are managed within their project plans." : "Updates are limited to the projects and records visible to your role."}</p>}
      {(section === "interns" || section === "employees" || section === "teams") && <nav className="segmented-tabs" aria-label="Interns, employees, and team management">
        <Link className={`segmented-tab ${section === "interns" ? "active" : ""}`} href="/admin/interns" aria-current={section === "interns" ? "page" : undefined}><GraduationCap size={14} /> Interns <span>{section === "interns" ? records.length : auxiliary.interns.length}</span></Link>
        <Link className={`segmented-tab ${section === "employees" ? "active" : ""}`} href="/admin/employees" aria-current={section === "employees" ? "page" : undefined}><UserPlus size={14} /> Full-time employees <span>{section === "employees" ? records.length : auxiliary.users.filter((item) => item.role === "team_member").length}</span></Link>
        <Link className={`segmented-tab ${section === "teams" ? "active" : ""}`} href="/admin/teams" aria-current={section === "teams" ? "page" : undefined}><UsersRound size={14} /> Team Management <span>{section === "teams" ? records.length : auxiliary.teams.length}</span></Link>
      </nav>}
      {rowError && <div className="notice notice-warning row-error" role="alert"><ShieldAlert size={15} />{rowError}<button className="icon-button" type="button" onClick={() => setRowError("")} aria-label="Dismiss error"><X size={14} /></button></div>}
      {section === "settings" ? (
        user.role === "team_member" ? (
          <section className="panel settings-panel">
            <div className="panel-header"><div><div className="panel-title">My account</div><div className="panel-subtitle">Your workspace sign-in and employee details</div></div><span className="stat-icon"><UserPlus size={15} /></span></div>
            <dl className="account-settings-list">
              <div><dt>Full name</dt><dd>{user.displayName}</dd></div>
              <div><dt>Work email</dt><dd>{user.email}</dd></div>
              <div><dt>Employee ID</dt><dd>{user.uid}</dd></div>
              <div><dt>Designation</dt><dd>{user.designation || "Team member"}</dd></div>
            </dl>
            <p className="settings-help">To change your sign-in password, request a secure reset link using your work email.</p>
            <div className="settings-actions"><Link className="button button-secondary" href="/forgot-password">Reset password</Link></div>
          </section>
        ) : <CompanySettings />
      ) : !collection ? (
        <div className="panel"><div className="empty-state"><div><span className="empty-icon"><FolderKanban size={18} /></span><h3>{section === "updates" ? "No project updates" : "No records yet"}</h3><p>{emptyMessage(collection, section)}</p></div></div></div>
      ) : (
        <>
        {section === "reports" && user.role === "super_admin" && <section className="panel team-output-panel">
          <div className="panel-header"><div><div className="panel-title">Team work summary</div><div className="panel-subtitle">All-time hours and work reports by employee</div></div></div>
          <div className="stats-grid team-output-stats">
            <article className="stat-card"><div className="stat-top"><span>Team members</span></div><div className="stat-value">{teamWorkSummary.length}</div><div className="stat-foot">Including suspended accounts</div></article>
            <article className="stat-card"><div className="stat-top"><span>Reports submitted</span></div><div className="stat-value">{teamWorkSummary.reduce((sum, member) => sum + member.reportCount, 0)}</div><div className="stat-foot">Across all team members</div></article>
            <article className="stat-card"><div className="stat-top"><span>Hours reported</span></div><div className="stat-value">{teamWorkSummary.reduce((sum, member) => sum + member.hoursLogged, 0).toLocaleString("en-IN", { maximumFractionDigits: 1 })}</div><div className="stat-foot">Logged through work reports</div></article>
          </div>
          <div className="table-scroll team-output-table-wrap">
            <table className="data-table">
              <thead><tr><th>TEAM MEMBER</th><th>DESIGNATION</th><th>REPORTS</th><th>HOURS REPORTED</th><th>ACCESS</th></tr></thead>
              <tbody>{teamWorkSummary.map((member) => <tr key={member.uid}>
                <td className="primary-cell">{member.displayName}</td>
                <td>{member.designation || "Team member"}</td>
                <td>{member.reportCount}</td>
                <td>{member.hoursLogged.toLocaleString("en-IN", { maximumFractionDigits: 1 })} h</td>
                <td><span className={`status-badge status-${member.accountStatus}`}>{member.accountStatus}</span></td>
              </tr>)}
              {!teamWorkSummary.length && <tr><td className="empty-table" colSpan={5}><span className="empty-icon"><ClipboardCheck size={17} /></span><h3>No team members yet</h3><p>Employee work summaries will appear here after accounts are created.</p></td></tr>}</tbody>
            </table>
          </div>
        </section>}
        <section className="panel records-panel">
          <div className="section-toolbar">
            <label className="search-box"><Search size={14} /><input aria-label="Search records" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder={`Search ${section.replaceAll("-", " ")}`} /></label>
            <div className="toolbar-actions">
              <select className="filter-select" aria-label={collection === "teams" ? "Filter by team category" : "Filter by status"} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(0); }}>
                <option value="all">{collection === "teams" ? "All categories" : "All statuses"}</option>
                {[...new Set(records.map((record) => collection === "teams" ? String(record.category ?? "General") : collection === "clients" ? String(record.approvalStatus ?? (record.status === "draft" ? "pending" : "approved")) : String(record.status ?? record.accountStatus ?? "")).filter(Boolean))].map((filterOption) => <option value={filterOption} key={filterOption}>{filterOption.replaceAll("_", " ")}</option>)}
              </select>
              {canCreate && <button className="button button-primary" type="button" onClick={() => setFormOpen(true)}><Plus size={15} />{section === "employees" ? "Add employee" : collection === "users" ? "Create user" : `New ${section.replaceAll("-", " ").replace(/s$/, "")}`}</button>}
            </div>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr>{currentColumns.map((column) => <th key={column.key}>{column.label.toUpperCase()}</th>)}{hasActionColumn(collection, user) && <th>ACTIONS</th>}</tr></thead>
              <tbody>
                {pageRecords.map((record) => <tr key={record.id}>
                  {currentColumns.map((column) => {
                    const value = record[column.key];
                    if (column.key === "approvalStatus") {
                      const approval = recordApproval(collection, record);
                      return <td key={column.key}><span className={`status-badge status-${approval}`}>{humanize(approval)}</span></td>;
                    }
                    if (column.key === "assignedTeamMembers") return <td key={column.key} className="team-cell">{teamSummary(record)}</td>;
                    const computed = derivedCell(collection, column.key, record, auxiliary);
                    if (computed !== null) return <td key={column.key} className="team-cell">{computed}</td>;
                    if (column.key === "status" || column.key === "accountStatus") return <td key={column.key}><span className={`status-badge status-${String(value ?? "unknown")}`}>{humanize(value)}</span></td>;
                    if (collection === "interns" || collection === "teams") {
                      if (column.key === "status") return <td key={column.key}><span className={`status-badge status-${String(value ?? "unknown")}`}>{humanize(value)}</span></td>;
                      if (isDateField(column.key)) return <td key={column.key}>{dateDisplay(value)}</td>;
                      if (collection === "teams" && column.key === "id") return <td key={column.key}><code className="team-id" title={String(value ?? record.id)}>{String(value ?? record.id)}</code></td>;
                      if (collection === "teams" && column.key === "category") return <td key={column.key}>{plainText(value ?? "General")}</td>;
                      return <td className={column.primary ? "primary-cell" : undefined} key={column.key}>{plainText(value)}</td>;
                    }
                    if (column.primary) return <td className="primary-cell" key={column.key}>{humanize(value)}{collection === "projects" && record.clientName ? <span className="secondary-cell">{humanize(record.clientName)}</span> : null}</td>;
                    if (isDateField(column.key)) return <td key={column.key}>{dateDisplay(value)}</td>;
                    if (column.key === "progressPercentage") return <td key={column.key}>{typeof value === "number" ? `${value}%` : "—"}</td>;
                    if (column.key === "expectedDurationMonths") return <td key={column.key}>{value ? `${humanize(value)} mo` : "—"}</td>;
                    return <td key={column.key}>{humanize(value)}</td>;
                  })}
                  {hasActions(collection, user, record) && <td><div className="table-actions">
                    {collection === "projectRequests" && canReview && record.status !== "draft" && <button className="small-action" type="button" onClick={() => setReviewRecord(record)} disabled={rowPending === record.id}><ClipboardList size={12} /> Review</button>}
                    {collection === "projectRequests" && user.role === "product_manager" && (record.status === "changes_requested" || record.status === "draft") && <button className="small-action" type="button" onClick={() => { setEditRecord(record); setFormOpen(true); }}><ClipboardList size={12} />{record.status === "draft" ? "Edit draft" : "Revise"}</button>}
                    {collection === "projectRequests" && user.role === "product_manager" && record.status === "draft" && <button className="small-action" type="button" onClick={() => patchRecord(record.id, "projectRequests", { action: "submit_draft" })} disabled={rowPending === record.id}><Check size={12} /> Submit</button>}
                    {collection === "workReports" && canReview && ["submitted", "under_review"].includes(String(record.status)) && <button className="small-action" type="button" onClick={() => setReviewRecord(record)} disabled={rowPending === record.id}><ClipboardCheck size={12} /> Review</button>}
                    {collection === "workReports" && user.role === "team_member" && record.status === "changes_requested" && <button className="small-action" type="button" onClick={() => { setEditRecord(record); setFormOpen(true); }}><ClipboardCheck size={12} /> Revise</button>}
                    {collection === "tasks" && user.role === "team_member" && record.status !== "completed" && <button className="small-action" type="button" onClick={() => patchRecord(record.id, "tasks", { status: record.status === "open" ? "in_progress" : "completed" })} disabled={rowPending === record.id}><Check size={12} />{record.status === "open" ? "Start task" : "Complete"}</button>}
                    {collection === "tasks" && (user.role === "cto" || user.role === "super_admin") && <button className="small-action" type="button" onClick={() => patchRecord(record.id, "tasks", { status: record.status === "blocked" ? "open" : "blocked" })} disabled={rowPending === record.id}><ShieldAlert size={12} />{record.status === "blocked" ? "Unblock" : "Block"}</button>}
                    {collection === "milestones" && (user.role === "cto" || user.role === "super_admin") && <button className="small-action" type="button" onClick={() => patchRecord(record.id, "milestones", { status: "completed" })} disabled={rowPending === record.id}><Check size={12} /> Complete</button>}
                    {collection === "projects" && user.role === "super_admin" && isProjectReviewable(record) && <button className="small-action" type="button" onClick={() => setReviewRecord(record)} disabled={rowPending === record.id}><ClipboardCheck size={12} />{projectApprovalStatus(record) === "rejected" ? "Review again" : "Review"}</button>}
                    {collection === "projects" && user.role === "super_admin" && !isProjectReviewable(record) && <button className="small-action" type="button" onClick={() => { setEditRecord(record); setFormOpen(true); }}><FolderKanban size={12} /> Update</button>}
                    {collection === "projects" && <button className="small-action" type="button" onClick={() => setDetailRecord(record)}><Eye size={12} /> Details</button>}
                    {collection === "users" && user.role === "super_admin" && record.uid !== user.uid && <>
                      {section !== "employees" && <>
                        <label className="visually-hidden" htmlFor={`role-${record.id}`}>Change role for {String(record.displayName ?? record.email)}</label>
                        <select className="role-select" id={`role-${record.id}`} value={String(record.role)} disabled={rowPending === record.id} onChange={(event) => {
                          const nextRole = event.target.value;
                          if (nextRole !== record.role && window.confirm(`Change ${String(record.displayName ?? record.email)} to ${nextRole.replaceAll("_", " ")}?`)) {
                            void patchRecord(record.id, "users", { operation: "change_role", role: nextRole });
                          } else {
                            router.refresh();
                          }
                        }}>
                          {roleOptions().map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </>}
                      <button className="small-action" type="button" onClick={() => {
                        const nextStatus = record.accountStatus === "active" ? "suspended" : "active";
                        if (nextStatus !== "active" && !window.confirm(`Suspend ${String(record.displayName ?? record.email)}? They will lose access immediately.`)) return;
                        void patchRecord(record.id, "users", { operation: "set_status", accountStatus: nextStatus });
                      }} disabled={rowPending === record.id}><ShieldAlert size={12} />{record.accountStatus === "active" ? "Suspend" : "Reactivate"}</button>
                      {record.role === "team_member" && <button className="small-action small-action-danger" type="button" onClick={() => {
                        setDeleteTarget(record);
                        setDeleteStage("confirm");
                        setDeletePassword("");
                        setDeleteError("");
                      }} disabled={rowPending === record.id || deletePending} aria-label={`Delete team member ${String(record.displayName ?? record.email)}`}><Trash2 size={12} /> Delete</button>}
                    </>}
                    {collection === "notifications" && !record.readAt && <button className="small-action" type="button" onClick={() => patchRecord(record.id, "notifications", { read: true })} disabled={rowPending === record.id}><Check size={12} />Mark read</button>}
                    {collection === "clients" && user.role === "super_admin" && ["pending", "rejected"].includes(String(record.approvalStatus ?? (record.status === "draft" ? "pending" : "approved"))) && <button className="small-action" type="button" onClick={() => setReviewRecord(record)} disabled={rowPending === record.id}><ClipboardCheck size={12} />{record.approvalStatus === "rejected" ? "Review again" : "Review"}</button>}
                    {collection === "clients" && user.role === "super_admin" && <button className="small-action" type="button" onClick={() => { setEditRecord(record); setFormOpen(true); }}><Building2 size={12} /> Edit</button>}
                    {collection === "clients" && user.role === "super_admin" && <button className="small-action small-action-danger" type="button" disabled={rowPending === record.id} onClick={() => {
                      const label = String(record.clientName ?? record.companyName ?? record.id);
                      if (window.confirm(`Delete client ${label}? Clients linked to projects or project requests must be unlinked first.`)) {
                        void patchRecord(record.id, "clients", { operation: "delete" });
                      }
                    }}><Trash2 size={12} /> Delete</button>}
                    {collection === "teams" && user.role === "super_admin" && <button className="small-action" type="button" onClick={() => { setManageTeam(record); setEmployeeToAdd(""); setInternToAdd(""); }} disabled={rowPending === record.id}><UsersRound size={12} /> Manage members</button>}
                    {(collection === "interns" || collection === "teams") && user.role === "super_admin" && <>
                      <button className="small-action" type="button" onClick={() => { setEditRecord(record); setFormOpen(true); }} disabled={rowPending === record.id}><Pencil size={12} /> Edit</button>
                      <button className="small-action small-action-danger" type="button" disabled={rowPending === record.id} onClick={() => {
                        const label = collection === "interns" ? String(record.fullName ?? record.id) : String(record.name ?? record.id);
                        const warning = collection === "interns" ? `Remove intern ${label}? They will also be removed from their teams and projects.` : `Delete team ${label}? Its people will be removed from projects they joined only through this team.`;
                        if (window.confirm(warning)) void patchRecord(record.id, collection, { operation: "delete" });
                      }}><Trash2 size={12} />{collection === "interns" ? "Remove" : "Delete"}</button>
                    </>}
                  </div></td>}
                </tr>)}
                {!pageRecords.length && <tr><td className="empty-table" colSpan={Math.max(currentColumns.length + (hasActionColumn(collection, user) ? 1 : 0), 1)}><span className="empty-icon"><EmptyIcon collection={collection} /></span><h3>{records.length ? "No matching records" : "No records yet"}</h3><p>{records.length ? collection === "teams" ? "Try a different search or team category." : "Try a different search or status filter." : emptyMessage(collection, section)}</p>{canCreate && !records.length && <button className="button button-secondary" type="button" onClick={() => setFormOpen(true)}><Plus size={14} /> Create your first record</button>}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="table-footer"><span>{filtered.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, filtered.length)} of ${filtered.length} records` : "0 records"}</span><div className="pagination"><button className="page-button" type="button" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0} aria-label="Previous page"><ChevronLeft size={14} /></button><span>{pages ? page + 1 : 0} / {pages}</span><button className="page-button" type="button" onClick={() => setPage((value) => Math.min(pages - 1, value + 1))} disabled={page >= pages - 1} aria-label="Next page"><ChevronRight size={14} /></button></div></div>
        </section>
        </>
      )}

      {formOpen && collection && fields.length > 0 && (
        <RecordForm
          fields={editRecord && collection === "workReports" ? fields.filter((field) => field.name !== "projectId" && field.name !== "taskId" && field.name !== "workDate") : editRecord && collection === "projectRequests" ? fields.filter((field) => field.name !== "status") : editRecord && collection === "projects" ? [
            { name: "status", label: "Project status", type: "select", required: true, options: projectStatusOptions },
            { name: "progressPercentage", label: "Progress percentage", type: "number", required: true, min: 0, max: 100 },
            { name: "contractPrice", label: "Contract price", type: "number", min: 0 },
            { name: "currency", label: "Currency code" },
            { name: "startDate", label: "Start date", type: "date" },
            { name: "expectedEndDate", label: "Expected end date", type: "date" },
            { name: "durationMonths", label: "Agreed duration (months)", type: "number", min: 1, max: 120 },
            { name: "priority", label: "Priority", type: "select", options: priorityOptions },
            ...(user.role === "super_admin" ? [{ name: "assignedCto", label: "Assigned CTO (optional)", type: "select" as const, options: fieldOptions(auxiliary.users.filter((record) => record.role === "cto" && record.accountStatus === "active"), "id", "displayName") }] : []),
            { name: "assignedTeam", label: "Individual team members", type: "select", multiple: true, options: fieldOptions(auxiliary.users.filter((record) => record.role === "team_member" && record.accountStatus === "active"), "id", "displayName") },
            { name: "teamIds", label: "Teams", type: "select", multiple: true, options: fieldOptions(auxiliary.teams, "id", "name") },
          ].map((field) => withExistingOptions([field as Field], editRecord, auxiliary)[0]) : editRecord && collection === "interns" ? withExistingOptions(fields.filter((field) => field.name !== "internId"), editRecord, auxiliary) : editRecord && collection === "teams" ? withExistingOptions(fields, editRecord, auxiliary) : fields}
          sendClearedFields={Boolean(editRecord && (collection === "interns" || collection === "teams"))}
          title={editRecord ? collection === "workReports" ? "Revise work report" : collection === "projectRequests" ? "Revise project request" : collection === "projects" ? "Update project delivery" : collection === "interns" ? `Edit intern ${String(editRecord.internId ?? "")}` : collection === "teams" ? "Edit team" : "Edit client" : section === "employees" ? "Add a full-time employee" : collection === "users" ? "Create a workspace user" : collection === "interns" ? "Add an intern" : collection === "teams" ? "Create a team" : collection === "projects" && user.role !== "super_admin" ? "Submit a project for approval" : `Create ${section.replaceAll("-", " ").replace(/s$/, "")}`}
          description={editRecord ? collection === "workReports" ? "Your previous report version will remain in the revision history." : collection === "projectRequests" ? "Your previous submission will remain in the revision history." : collection === "projects" ? "Update project delivery, commercial terms, and team. Everyone in a selected team is added to the project." : collection === "teams" ? "Edit the team category, name, members, and project assignments." : "Changes are saved with an audit record." : section === "employees" ? "Create a workspace account for a full-time employee. Their role is set to Team member so they can join teams and projects." : collection === "interns" ? "Give the intern a unique ID and role. You can assign projects now or later, and add them to teams from Team Management." : collection === "teams" ? "Create a category-based team. Its ID and creation date are saved automatically; add employees and interns now or manage them later." : collection === "users" ? "Set a unique user ID, login email, role, and initial password." : collection === "clients" && user.role !== "super_admin" ? "New client submissions stay pending until a Super Admin approves them." : collection === "projects" && user.role !== "super_admin" ? "Your project stays pending until a Super Admin approves it and assigns a team. You can follow its status from this page." : collection === "projectRequests" ? "Save a draft for later or submit the request to the CTO for review." : "Complete the required details. Record access is checked again on the server."}
          endpoint={editRecord ? `/api/records/${collection}/${editRecord.id}` : `/api/records/${collection}`}
          method={editRecord ? "PATCH" : "POST"}
          extraPayload={section === "employees" && !editRecord ? { role: "team_member" } : editRecord && collection === "workReports" ? { operation: "revise" } : editRecord && collection === "projectRequests" ? { action: "revise" } : undefined}
          initialValues={editRecord && collection === "projects" ? { ...editRecord, assignedTeam: directTeamOf(editRecord), teamIds: projectTeams(editRecord).map((team) => team.id) } : editRecord && collection === "teams" ? { ...editRecord, category: String(editRecord.category ?? "General") } : editRecord ?? (collection === "interns" ? { status: "active", joiningDate: companyDate } : collection === "teams" ? { category: "General" } : collection === "workReports" ? { workDate: companyDate } : collection === "projectRequests" ? { status: "pending_cto_review", currency: "INR" } : collection === "clients" && user.role === "super_admin" ? { status: "active" } : collection === "projects" ? user.role === "super_admin" ? { currency: "INR", priority: "normal" } : { priority: "normal" } : collection === "tasks" ? { priority: "normal" } : {})}
          onClose={() => { setFormOpen(false); setEditRecord(null); }}
          onSuccess={formSucceeded}
        />
      )}
      {detailRecord && <ProjectDetailsDialog record={detailRecord} onClose={() => setDetailRecord(null)} />}
      {manageTeam && <div className="modal-backdrop" role="presentation" data-lenis-prevent onMouseDown={(event) => { if (event.target === event.currentTarget) setManageTeam(null); }}>
        <section className="modal-card team-members-dialog" role="dialog" aria-modal="true" aria-labelledby="team-members-title">
          <header className="modal-header">
            <div><h2 id="team-members-title">Manage members</h2><p>{String(manageTeam.name ?? "Team")} · {String(manageTeam.category ?? "General")} · ID: {manageTeam.id}</p></div>
            <button className="icon-button" type="button" onClick={() => setManageTeam(null)} aria-label="Close member manager"><X size={17} /></button>
          </header>
          <div className="team-members-content">
            <section className="team-member-group">
              <div className="team-member-heading"><div><h3>Employees</h3><span>{idsOf(manageTeam.memberUids).length} assigned</span></div></div>
              {idsOf(manageTeam.memberUids).length ? <ul className="team-member-list">{idsOf(manageTeam.memberUids).map((id) => {
                const employee = auxiliary.users.find((record) => record.id === id);
                return <li key={id}><span className="avatar avatar-small" aria-hidden="true">{String(employee?.displayName ?? id).trim().slice(0, 1).toUpperCase() || "E"}</span><span className="team-member-copy"><strong>{String(employee?.displayName ?? "Employee")}</strong><small>{String(employee?.designation ?? employee?.email ?? id)}</small></span><button className="small-action small-action-danger" type="button" onClick={() => void changeTeamMembership("employee", id, "remove")} disabled={rowPending === manageTeam.id}><Trash2 size={12} /> Remove</button></li>;
              })}</ul> : <p className="form-note">No employees have been added yet.</p>}
              <div className="team-member-add"><label className="visually-hidden" htmlFor="add-team-employee">Add an employee</label><select className="select-input" id="add-team-employee" value={employeeToAdd} onChange={(event) => setEmployeeToAdd(event.target.value)}><option value="">Select an employee</option>{auxiliary.users.filter((record) => record.role === "team_member" && record.accountStatus === "active" && !idsOf(manageTeam.memberUids).includes(record.id)).map((record) => <option value={record.id} key={record.id}>{String(record.displayName ?? record.email ?? record.id)}</option>)}</select><button className="button button-secondary" type="button" onClick={() => void changeTeamMembership("employee", employeeToAdd, "add")} disabled={!employeeToAdd || rowPending === manageTeam.id}><Plus size={14} /> Add employee</button></div>
            </section>
            <section className="team-member-group">
              <div className="team-member-heading"><div><h3>Interns</h3><span>{idsOf(manageTeam.internIds).length} assigned</span></div></div>
              {idsOf(manageTeam.internIds).length ? <ul className="team-member-list">{idsOf(manageTeam.internIds).map((id) => {
                const intern = auxiliary.interns.find((record) => record.id === id);
                return <li key={id}><span className="avatar avatar-small" aria-hidden="true">{String(intern?.fullName ?? id).trim().slice(0, 1).toUpperCase() || "I"}</span><span className="team-member-copy"><strong>{String(intern?.fullName ?? "Intern")}</strong><small>{[intern?.role, intern?.internId].filter(Boolean).map(String).join(" · ") || id}</small></span><button className="small-action small-action-danger" type="button" onClick={() => void changeTeamMembership("intern", id, "remove")} disabled={rowPending === manageTeam.id}><Trash2 size={12} /> Remove</button></li>;
              })}</ul> : <p className="form-note">No interns have been added yet.</p>}
              <div className="team-member-add"><label className="visually-hidden" htmlFor="add-team-intern">Add an intern</label><select className="select-input" id="add-team-intern" value={internToAdd} onChange={(event) => setInternToAdd(event.target.value)}><option value="">Select an intern</option>{auxiliary.interns.filter((record) => record.status !== "discontinued" && !idsOf(manageTeam.internIds).includes(record.id)).map((record) => <option value={record.id} key={record.id}>{String(record.fullName ?? record.id)} · {String(record.internId ?? record.id)}</option>)}</select><button className="button button-secondary" type="button" onClick={() => void changeTeamMembership("intern", internToAdd, "add")} disabled={!internToAdd || rowPending === manageTeam.id}><Plus size={14} /> Add intern</button></div>
            </section>
          </div>
        </section>
      </div>}
      {reviewRecord && collection && <ReviewDialog collection={collection} record={reviewRecord} users={auxiliary.users} teams={auxiliary.teams} onClose={() => setReviewRecord(null)} onComplete={() => { setReviewRecord(null); router.refresh(); }} />}
      {deleteTarget && <div className="modal-backdrop" role="presentation" data-lenis-prevent onMouseDown={(event) => { if (event.target === event.currentTarget) closeDeleteDialog(); }}>
        <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="delete-user-title">
          <header className="modal-header">
            <div>
              <h2 id="delete-user-title">{deleteStage === "confirm" ? "Delete team member?" : "Confirm with your password"}</h2>
              <p>{String(deleteTarget.displayName ?? deleteTarget.email ?? "Team member")}</p>
            </div>
            <button className="icon-button" type="button" onClick={closeDeleteDialog} aria-label="Close delete dialog" disabled={deletePending}><X size={17} /></button>
          </header>
          <form className="review-form" onSubmit={(event) => { event.preventDefault(); void confirmTeamMemberDelete(); }}>
            {deleteStage === "confirm" ? (
              <p className="delete-confirm-copy">This permanently removes the account and stops access immediately. Existing project and work-report history will remain in the workspace.</p>
            ) : <>
              <label className="field-label" htmlFor="delete-user-password">Super Admin password</label>
              <input className="text-input" id="delete-user-password" type="password" value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} autoComplete="current-password" required maxLength={128} aria-describedby="delete-user-password-help" />
              <p className="form-helper delete-password-help" id="delete-user-password-help">Password checks are limited to five attempts per hour.</p>
            </>}
            {deleteError && <div className="form-error-inline" role="alert">{deleteError}</div>}
            <div className="form-actions">
              <button className="button button-secondary" type="button" onClick={closeDeleteDialog} disabled={deletePending}>Cancel</button>
              <button className="button button-danger" type="submit" disabled={deletePending || deleteStage === "password" && !deletePassword}>
                {deletePending ? "Deleting…" : deleteStage === "confirm" ? "Continue" : "Delete account"}
              </button>
            </div>
          </form>
        </section>
      </div>}
    </>
  );
}

function hasActionColumn(collection: CollectionName | null, user: SessionUser) {
  if (collection === "projects") return true;
  if (collection === "interns" || collection === "teams") return user.role === "super_admin";
  if (collection === "milestones") return user.role === "super_admin" || user.role === "cto";
  if (collection === "projectRequests") return user.role === "super_admin" || user.role === "cto" || user.role === "product_manager";
  if (collection === "workReports") return user.role !== "product_manager";
  if (collection === "tasks") return true;
  if (collection === "users") return user.role === "super_admin";
  if (collection === "notifications") return true;
  if (collection === "clients") return user.role === "super_admin";
  return false;
}

function hasActions(collection: CollectionName, user: SessionUser, record: RecordData) {
  if (collection === "projects") return true;
  if (collection === "interns" || collection === "teams") return user.role === "super_admin" && Boolean(record.id);
  if (collection === "milestones") return (user.role === "super_admin" || user.role === "cto") && record.status !== "completed";
  if (collection === "projectRequests") return (user.role === "super_admin" || user.role === "cto") && ["pending_cto_review", "changes_requested"].includes(String(record.status)) || user.role === "product_manager" && ["changes_requested", "draft"].includes(String(record.status));
  if (collection === "workReports") return (user.role === "super_admin" || user.role === "cto") && ["submitted", "under_review"].includes(String(record.status)) || user.role === "team_member" && record.status === "changes_requested";
  if (collection === "tasks") return user.role === "team_member" && record.status !== "completed" || user.role === "super_admin" || user.role === "cto";
  if (collection === "users") return user.role === "super_admin" && record.uid !== user.uid;
  if (collection === "notifications") return user.role === "super_admin" || user.role === "cto" || user.role === "product_manager" || user.role === "team_member";
  if (collection === "clients") return user.role === "super_admin";
  return false;
}

function EmptyIcon({ collection }: { collection: CollectionName }) {
  if (collection === "clients") return <Building2 size={17} />;
  if (collection === "projects") return <FolderKanban size={17} />;
  if (collection === "projectRequests") return <ClipboardList size={17} />;
  if (collection === "tasks") return <ListTodo size={17} />;
  if (collection === "milestones") return <FileClock size={17} />;
  if (collection === "workReports") return <ClipboardCheck size={17} />;
  if (collection === "users") return <UserPlus size={17} />;
  if (collection === "interns") return <GraduationCap size={17} />;
  if (collection === "teams") return <UsersRound size={17} />;
  if (collection === "auditLogs") return <FileClock size={17} />;
  return <Bell size={17} />;
}
