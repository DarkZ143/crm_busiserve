import type { Role, RecordData, CollectionName } from "@/lib/types";

function without(record: RecordData, fields: string[]): RecordData {
  const safe = { ...record };
  for (const field of fields) delete safe[field];
  return safe;
}

const PROJECT_FINANCIAL_FIELDS = ["contractPrice", "proposedPrice", "currency", "budget", "internalFinancialNotes"];

export function redactRecordForRole(collection: CollectionName, record: RecordData, role: Role, uid?: string): RecordData {
  if (role === "super_admin") return record;
  if (collection === "clients") return without(record, ["internalNotes", "officialEmailNormalized"]);
  if (collection === "users" && role === "cto") return without(record, ["email", "accountStatus", "createdBy"]);
  // A CTO who only submitted a project, and was not made its lead, follows approval and team but not commercials.
  if (collection === "projects" && role === "cto" && uid !== undefined && record.assignedCto !== uid) return without(record, PROJECT_FINANCIAL_FIELDS);
  if (role === "cto") return record;
  if (collection === "projectRequests") return without(record, ["proposedPrice", "contractPrice", "internalNotes"]);
  if (collection === "projects" && role === "product_manager") {
    return without(record, ["contractPrice", "currency", "budget", "internalFinancialNotes"]);
  }
  if (collection === "projects" && role === "team_member") {
    return without(record, ["contractPrice", "proposedPrice", "currency", "budget", "clientEmail", "clientPhone", "internalFinancialNotes"]);
  }
  if (collection === "workReports" && role === "product_manager") {
    return without(record, ["employeeId", "employeeName", "reviewerComments", "reviewedBy"]);
  }
  if (collection === "users") return without(record, ["email", "accountStatus", "createdBy"]);
  return record;
}
