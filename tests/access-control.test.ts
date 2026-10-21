import { describe, expect, it } from "vitest";
import { canAccessArea, canReadCollection, canReadRecord } from "../lib/access-control";
import { redactRecordForRole } from "../lib/record-security";

describe("workspace authorization", () => {
  it("limits each role to its workspace area", () => {
    expect(canAccessArea("team_member", "workspace")).toBe(true);
    expect(canAccessArea("team_member", "admin")).toBe(false);
    expect(canAccessArea("product_manager", "cto")).toBe(false);
    expect(canAccessArea("super_admin", "cto")).toBe(true);
  });

  it("limits team members to their assigned projects and tasks", () => {
    const assignedProject = { id: "project-a", assignedTeam: ["member-a"] };
    const otherProject = { id: "project-b", assignedTeam: ["member-b"] };
    expect(canReadRecord("team_member", "member-a", "projects", assignedProject)).toBe(true);
    expect(canReadRecord("team_member", "member-a", "projects", otherProject)).toBe(false);
    // A team member reads the whole board of a project they are on, whoever each task went to.
    expect(canReadRecord("team_member", "member-a", "tasks", { projectId: "project-a", assigneeId: "member-b" }, new Set(["project-a"]))).toBe(true);
    expect(canReadRecord("team_member", "member-a", "tasks", { projectId: "project-a", assigneeId: "member-a" }, new Set(["project-a"]))).toBe(true);
    expect(canReadRecord("team_member", "member-a", "tasks", { projectId: "project-b", assigneeId: "member-a" }, new Set(["project-a"]))).toBe(false);
  });

  it("gives interns the workspace area and nothing else", () => {
    expect(canAccessArea("intern", "workspace")).toBe(true);
    expect(canAccessArea("intern", "admin")).toBe(false);
    expect(canAccessArea("intern", "cto")).toBe(false);
    expect(canReadCollection("intern", "tasks")).toBe(true);
    expect(canReadCollection("intern", "projects")).toBe(true);
    expect(canReadCollection("intern", "workReports")).toBe(true);
    expect(canReadCollection("intern", "clients")).toBe(false);
    expect(canReadCollection("intern", "users")).toBe(false);
    expect(canReadCollection("intern", "interns")).toBe(false);
  });

  it("limits interns to their own assigned projects, tasks, and reports", () => {
    expect(canReadRecord("intern", "intern-a", "projects", { id: "project-a", assignedTeam: ["intern-a"] })).toBe(true);
    expect(canReadRecord("intern", "intern-a", "projects", { id: "project-b", assignedTeam: ["member-b"] })).toBe(false);
    expect(canReadRecord("intern", "intern-a", "tasks", { projectId: "project-a", assigneeId: "intern-a" }, new Set(["project-a"]))).toBe(true);
    expect(canReadRecord("intern", "intern-a", "tasks", { projectId: "project-a", assigneeId: "member-b" }, new Set(["project-a"]))).toBe(false);
    expect(canReadRecord("intern", "intern-a", "workReports", { employeeId: "intern-a" })).toBe(true);
    expect(canReadRecord("intern", "intern-a", "workReports", { employeeId: "member-b" })).toBe(false);
    expect(canReadRecord("intern", "intern-a", "clients", { createdBy: "intern-a" })).toBe(false);
  });

  it("lets a full-time employee look after the interns and tasks they took on", () => {
    expect(canReadCollection("team_member", "interns")).toBe(true);
    expect(canReadCollection("team_member", "tasks")).toBe(true);
    expect(canReadCollection("team_member", "clients")).toBe(false);
    // The intern roster is company-wide, so a colleague's intern is readable and assignable.
    expect(canReadRecord("team_member", "emp-a", "interns", { createdBy: "emp-a" })).toBe(true);
    expect(canReadRecord("team_member", "emp-a", "interns", { createdBy: "emp-b" })).toBe(true);
    // Every task on their project: their own, the ones they handed to an intern, and the ones a Super
    // Admin assigned without them.
    const onProject = new Set(["project-a"]);
    expect(canReadRecord("team_member", "emp-a", "tasks", { projectId: "project-a", assigneeId: "emp-a", createdBy: "admin" }, onProject)).toBe(true);
    expect(canReadRecord("team_member", "emp-a", "tasks", { projectId: "project-a", assigneeId: "intern-a", createdBy: "emp-a" }, onProject)).toBe(true);
    expect(canReadRecord("team_member", "emp-a", "tasks", { projectId: "project-a", assigneeId: "intern-b", createdBy: "admin" }, onProject)).toBe(true);
    // A project they are not on stays out of reach, whoever the task belongs to.
    expect(canReadRecord("team_member", "emp-a", "tasks", { projectId: "project-b", assigneeId: "intern-a", createdBy: "emp-a" }, onProject)).toBe(false);
  });

  it("keeps interns out of records that belong to the people who manage them", () => {
    expect(canReadCollection("intern", "interns")).toBe(false);
    expect(canReadCollection("intern", "teams")).toBe(false);
    expect(canReadRecord("intern", "intern-a", "interns", { createdBy: "intern-a" })).toBe(false);
    expect(canReadRecord("intern", "intern-a", "teams", { memberUids: ["intern-a"] })).toBe(false);
  });

  it("shows an employee only the teams they are on", () => {
    expect(canReadCollection("team_member", "teams")).toBe(true);
    expect(canReadRecord("team_member", "emp-a", "teams", { memberUids: ["emp-a", "emp-b"] })).toBe(true);
    expect(canReadRecord("team_member", "emp-a", "teams", { memberUids: ["emp-b"] })).toBe(false);
    expect(canReadRecord("team_member", "emp-a", "teams", {})).toBe(false);
    // Being listed as a team's intern is not the same as being on it as an employee.
    expect(canReadRecord("team_member", "emp-a", "teams", { internIds: ["emp-a"], memberUids: [] })).toBe(false);
  });

  it("limits Product Managers to records they created or projects assigned to them", () => {
    expect(canReadRecord("product_manager", "pm-a", "clients", { createdBy: "pm-a" })).toBe(true);
    expect(canReadRecord("product_manager", "pm-a", "clients", { createdBy: "admin", assignedProductManager: "pm-a" })).toBe(true);
    expect(canReadRecord("product_manager", "pm-a", "clients", { createdBy: "pm-b" })).toBe(false);
    expect(canReadRecord("product_manager", "pm-a", "projects", { assignedProductManager: "pm-b" })).toBe(false);
    expect(canReadRecord("product_manager", "pm-a", "projects", { assignedProductManager: "pm-a" })).toBe(true);
    expect(canReadRecord("cto", "cto-a", "projectRequests", { status: "draft" })).toBe(false);
  });

  it("removes financial fields from Product Manager and team views", () => {
    const project = { id: "project-a", contractPrice: 125000, currency: "INR", clientPhone: "private", name: "Website" };
    const pmView = redactRecordForRole("projects", project, "product_manager");
    const teamView = redactRecordForRole("projects", project, "team_member");
    expect(pmView).not.toHaveProperty("contractPrice");
    expect(pmView).not.toHaveProperty("currency");
    expect(teamView).not.toHaveProperty("contractPrice");
    expect(teamView).not.toHaveProperty("clientPhone");
    const internView = redactRecordForRole("projects", project, "intern");
    expect(internView).not.toHaveProperty("contractPrice");
    expect(internView).not.toHaveProperty("clientPhone");
    expect(internView).toHaveProperty("name", "Website");
    expect(redactRecordForRole("projects", project, "super_admin")).toHaveProperty("contractPrice", 125000);
    expect(redactRecordForRole("projectRequests", { id: "request-a", proposedPrice: 45000 }, "product_manager")).not.toHaveProperty("proposedPrice");
  });
});
