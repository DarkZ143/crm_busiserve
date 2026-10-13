"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Bell, Building2, Check, ChevronLeft, ChevronRight, ClipboardCheck, ClipboardList, FileClock, FolderKanban, ListTodo, Plus, Search, ShieldAlert, Trash2, UserPlus, X } from "lucide-react";
import { CompanySettings } from "@/app/components/company-settings";
import type { CollectionName, RecordData, Role, SessionUser } from "@/lib/types";

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
};

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
    { key: "clientName", label: "Client", primary: true }, { key: "companyName", label: "Company" },
    { key: "officialEmail", label: "Email" }, { key: "industry", label: "Industry" },
    { key: "approvalStatus", label: "Approval" }, { key: "approvalComments", label: "Review notes" }, { key: "status", label: "Status" },
  ],
  projects: [
    { key: "name", label: "Project", primary: true }, { key: "projectId", label: "ID" }, { key: "status", label: "Status" },
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
  notifications: [
    { key: "title", label: "Update", primary: true }, { key: "body", label: "Details" }, { key: "kind", label: "Type" }, { key: "createdAt", label: "Received" },
  ],
};

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

function createFields(collection: CollectionName | null, role: Role, auxiliary: Auxiliary): Field[] {
  if (collection === "clients") return [
    { name: "clientName", label: "Client or organization name", required: true },
    { name: "contactPerson", label: "Contact person", required: true },
    { name: "officialEmail", label: "Official email", type: "email", required: true },
    { name: "contactNumber", label: "Contact number", required: true },
    { name: "companyName", label: "Company name" },
    { name: "industry", label: "Industry" },
    { name: "businessAddress", label: "Business address", full: true },
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
    { name: "contractPrice", label: "Contract price", type: "number", min: 0 },
    { name: "currency", label: "Currency code", placeholder: "INR" },
    { name: "startDate", label: "Start date", type: "date" },
    { name: "expectedEndDate", label: "Expected end date", type: "date" },
    { name: "durationMonths", label: "Agreed duration (months)", type: "number", min: 1, max: 120 },
    { name: "priority", label: "Priority", type: "select", options: priorityOptions },
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
    { name: "projectId", label: "Project", type: "select", required: true, options: fieldOptions(auxiliary.projects, "id", "name") },
    { name: "taskId", label: "Task (optional)", type: "select", options: [{ value: "", label: "Project update" }, ...fieldOptions(auxiliary.tasks, "id", "title")] },
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
  if (collection === "projects") return "Projects assigned to your role will appear here when they are created.";
  if (collection === "projectRequests") return "Project requests and review decisions will appear here.";
  if (collection === "tasks") return "Tasks assigned to your project teams will appear here.";
  if (collection === "workReports") return "Daily reports and review history will appear here.";
  if (collection === "users") return "Authorized workspace accounts will appear here.";
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
    const clean = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "" && value !== undefined));
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
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
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
  onClose,
  onComplete,
}: {
  collection: CollectionName;
  record: RecordData;
  users: RecordData[];
  onClose: () => void;
  onComplete: () => void;
}) {
  const requestKind = collection === "projectRequests";
  const clientKind = collection === "clients";
  const currentManager = users.find((user) => user.id === record.assignedProductManager && user.role === "product_manager" && user.accountStatus === "active");
  const [action, setAction] = useState(requestKind || clientKind ? "approve" : "accepted");
  const [comments, setComments] = useState(String(record.approvalComments ?? ""));
  const [assignedProductManager, setAssignedProductManager] = useState(String(currentManager?.id ?? ""));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setPending(true);
    setError("");
    try {
      const body = requestKind
        ? { action, reviewerComments: comments }
        : clientKind
          ? { operation: "review", action, assignedProductManager, reviewerComments: comments }
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
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card" role="dialog" aria-modal="true" aria-label="Review record">
        <header className="modal-header"><div><h2>{requestKind ? "Review project request" : clientKind ? "Review client submission" : "Review work report"}</h2><p>{String(record.clientName ?? record.projectName ?? record.workSummary ?? "Record")}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog"><X size={17} /></button></header>
        <div className="review-form">
          <label className="field-label" htmlFor="review-decision">Decision</label>
          <select className="select-input" id="review-decision" value={action} onChange={(event) => setAction(event.target.value)}>
            {requestKind ? <><option value="approve">Approve</option><option value="request_changes">Request changes</option><option value="reject">Reject</option></> : clientKind ? <><option value="approve">Approve client</option><option value="reject">Reject client</option></> : <><option value="accepted">Accept report</option><option value="under_review">Keep under review</option><option value="changes_requested">Request corrections</option></>}
          </select>
          {clientKind && action === "approve" && <>
            <label className="field-label" htmlFor="client-product-manager">Product Manager (optional)</label>
            <select className="select-input" id="client-product-manager" value={assignedProductManager} onChange={(event) => setAssignedProductManager(event.target.value)}>
              <option value="">No Product Manager assigned</option>
              {users.filter((user) => user.role === "product_manager" && user.accountStatus === "active").map((user) => <option value={String(user.id)} key={user.id}>{String(user.displayName ?? user.id)}</option>)}
            </select>
          </>}
          <label className="field-label" htmlFor="review-comments">Comments for the submitter</label>
          <textarea className="textarea-input" id="review-comments" value={comments} onChange={(event) => setComments(event.target.value)} maxLength={4000} placeholder="Add context or requested changes" />
          {error && <div className="form-error-inline" role="alert">{error}</div>}
          <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="button" onClick={submit} disabled={pending}>{pending ? "Saving…" : "Save decision"}</button></div>
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
  initialNewRecord = false,
}: {
  user: SessionUser;
  section: string;
  collection: CollectionName | null;
  records: RecordData[];
  auxiliary: Auxiliary;
  companyDate: string;
  initialNewRecord?: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [formOpen, setFormOpen] = useState(initialNewRecord);
  const [editRecord, setEditRecord] = useState<RecordData | null>(null);
  const [reviewRecord, setReviewRecord] = useState<RecordData | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RecordData | null>(null);
  const [deleteStage, setDeleteStage] = useState<"confirm" | "password">("confirm");
  const [deletePassword, setDeletePassword] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [createdUser, setCreatedUser] = useState<Record<string, unknown> | null>(null);
  const [rowPending, setRowPending] = useState("");
  const [rowError, setRowError] = useState("");
  const fields = createFields(collection, user.role, auxiliary);
  const canCreate = Boolean(collection && fields.length && (
    collection === "clients" ||
    collection === "projectRequests" && (user.role === "super_admin" || user.role === "product_manager") ||
    (collection === "projects" || collection === "tasks" || collection === "milestones") && user.role === "super_admin" ||
    collection === "workReports" && user.role === "team_member" ||
    collection === "users" && user.role === "super_admin"
  ));
  const currentColumns = collection ? columns[collection] ?? [] : [];
  const filtered = useMemo(() => records.filter((record) => {
    const matchesQuery = !query || Object.values(record).some((value) => String(value ?? "").toLowerCase().includes(query.toLowerCase()));
    const recordStatus = collection === "clients"
      ? String(record.approvalStatus ?? (record.status === "draft" ? "pending" : "approved"))
      : String(record.status ?? record.accountStatus ?? "");
    const matchesStatus = statusFilter === "all" || recordStatus === statusFilter;
    return matchesQuery && matchesStatus;
  }), [records, query, statusFilter, collection]);
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
  const heading = section === "updates" ? "Project updates" : section === "history" ? "Previous work reports" : section === "milestones" ? "Milestones" : section === "settings" ? "Company preferences" : "";

  return (
    <>
      {createdUser && <div className="invite-result"><div><strong>User account created</strong><span>Share the initial password securely. Passwords are not shown or saved in the user profile.</span><code>User ID: {String(createdUser.uid)} · Login: {String(createdUser.email)}</code></div><button className="icon-button" type="button" aria-label="Dismiss account details" onClick={() => setCreatedUser(null)}><X size={15} /></button></div>}
      {heading && <p className="section-description">{heading === "Company preferences" ? "Manage the workspace timezone and operational defaults." : heading === "Milestones" ? "Milestones are managed within their project plans." : "Updates are limited to the projects and records visible to your role."}</p>}
      {rowError && <div className="notice notice-warning row-error" role="alert"><ShieldAlert size={15} />{rowError}<button className="icon-button" type="button" onClick={() => setRowError("")} aria-label="Dismiss error"><X size={14} /></button></div>}
      {section === "settings" ? (
        <CompanySettings />
      ) : !collection ? (
        <div className="panel"><div className="empty-state"><div><span className="empty-icon"><FolderKanban size={18} /></span><h3>{section === "updates" ? "No project updates" : "No records yet"}</h3><p>{emptyMessage(collection, section)}</p></div></div></div>
      ) : (
        <section className="panel records-panel">
          <div className="section-toolbar">
            <label className="search-box"><Search size={14} /><input aria-label="Search records" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder={`Search ${section.replaceAll("-", " ")}`} /></label>
            <div className="toolbar-actions">
              <select className="filter-select" aria-label="Filter by status" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(0); }}>
                <option value="all">All statuses</option>
                {[...new Set(records.map((record) => collection === "clients" ? String(record.approvalStatus ?? (record.status === "draft" ? "pending" : "approved")) : String(record.status ?? record.accountStatus ?? "")).filter(Boolean))].map((status) => <option value={status} key={status}>{status.replaceAll("_", " ")}</option>)}
              </select>
              {canCreate && <button className="button button-primary" type="button" onClick={() => setFormOpen(true)}><Plus size={15} />{collection === "users" ? "Create user" : `New ${section.replaceAll("-", " ").replace(/s$/, "")}`}</button>}
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
                      const approval = value ?? (record.status === "draft" ? "pending" : "approved");
                      return <td key={column.key}><span className={`status-badge status-${String(approval)}`}>{humanize(approval)}</span></td>;
                    }
                    if (column.key === "status" || column.key === "accountStatus") return <td key={column.key}><span className={`status-badge status-${String(value ?? "unknown")}`}>{humanize(value)}</span></td>;
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
                    {collection === "projects" && user.role === "super_admin" && <button className="small-action" type="button" onClick={() => { setEditRecord(record); setFormOpen(true); }}><FolderKanban size={12} /> Update</button>}
                    {collection === "users" && user.role === "super_admin" && record.uid !== user.uid && <>
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
                  </div></td>}
                </tr>)}
                {!pageRecords.length && <tr><td className="empty-table" colSpan={Math.max(currentColumns.length + (hasActionColumn(collection, user) ? 1 : 0), 1)}><span className="empty-icon"><EmptyIcon collection={collection} /></span><h3>{records.length ? "No matching records" : "No records yet"}</h3><p>{records.length ? "Try a different search or status filter." : emptyMessage(collection, section)}</p>{canCreate && !records.length && <button className="button button-secondary" type="button" onClick={() => setFormOpen(true)}><Plus size={14} /> Create your first record</button>}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="table-footer"><span>{filtered.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, filtered.length)} of ${filtered.length} records` : "0 records"}</span><div className="pagination"><button className="page-button" type="button" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0} aria-label="Previous page"><ChevronLeft size={14} /></button><span>{pages ? page + 1 : 0} / {pages}</span><button className="page-button" type="button" onClick={() => setPage((value) => Math.min(pages - 1, value + 1))} disabled={page >= pages - 1} aria-label="Next page"><ChevronRight size={14} /></button></div></div>
        </section>
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
            ...(user.role === "super_admin" ? [{ name: "assignedCto", label: "Assigned CTO", type: "select" as const, required: true, options: fieldOptions(auxiliary.users.filter((record) => record.role === "cto" && record.accountStatus === "active"), "id", "displayName") }] : []),
            { name: "assignedTeam", label: "Assigned team members", type: "select", multiple: true, options: fieldOptions(auxiliary.users.filter((record) => record.role === "team_member" && record.accountStatus === "active"), "id", "displayName") },
          ] : fields}
          title={editRecord ? collection === "workReports" ? "Revise work report" : collection === "projectRequests" ? "Revise project request" : collection === "projects" ? "Update project delivery" : "Edit client" : collection === "users" ? "Create a workspace user" : `Create ${section.replaceAll("-", " ").replace(/s$/, "")}`}
          description={editRecord ? collection === "workReports" ? "Your previous report version will remain in the revision history." : collection === "projectRequests" ? "Your previous submission will remain in the revision history." : collection === "projects" ? "Update project delivery, commercial terms, and team. Changes are audited." : "Changes are saved with an audit record." : collection === "users" ? "Set a unique user ID, login email, role, and initial password." : collection === "clients" && user.role !== "super_admin" ? "New client submissions stay pending until a Super Admin approves them." : collection === "projectRequests" ? "Save a draft for later or submit the request to the CTO for review." : "Complete the required details. Record access is checked again on the server."}
          endpoint={editRecord ? `/api/records/${collection}/${editRecord.id}` : `/api/records/${collection}`}
          method={editRecord ? "PATCH" : "POST"}
          extraPayload={editRecord && collection === "workReports" ? { operation: "revise" } : editRecord && collection === "projectRequests" ? { action: "revise" } : undefined}
          initialValues={editRecord ?? (collection === "workReports" ? { workDate: companyDate } : collection === "projectRequests" ? { status: "pending_cto_review", currency: "INR" } : collection === "clients" && user.role === "super_admin" ? { status: "active" } : collection === "projects" ? { currency: "INR", priority: "normal" } : collection === "tasks" ? { priority: "normal" } : {})}
          onClose={() => { setFormOpen(false); setEditRecord(null); }}
          onSuccess={formSucceeded}
        />
      )}
      {reviewRecord && collection && <ReviewDialog collection={collection} record={reviewRecord} users={auxiliary.users} onClose={() => setReviewRecord(null)} onComplete={() => { setReviewRecord(null); router.refresh(); }} />}
      {deleteTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDeleteDialog(); }}>
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
  if (collection === "projects") return user.role === "super_admin";
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
  if (collection === "projects") return user.role === "super_admin";
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
  if (collection === "auditLogs") return <FileClock size={17} />;
  return <Bell size={17} />;
}
