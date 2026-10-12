import { describe, expect, it } from "vitest";
import { canAccessArea, canReadRecord } from "../lib/access-control";
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
    expect(canReadRecord("team_member", "member-a", "tasks", { projectId: "project-a", assigneeId: "member-b" }, new Set(["project-a"]))).toBe(false);
    expect(canReadRecord("team_member", "member-a", "tasks", { projectId: "project-a", assigneeId: "member-a" }, new Set(["project-a"]))).toBe(true);
    expect(canReadRecord("team_member", "member-a", "tasks", { projectId: "project-b", assigneeId: "member-a" }, new Set(["project-a"]))).toBe(false);
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
    expect(redactRecordForRole("projects", project, "super_admin")).toHaveProperty("contractPrice", 125000);
    expect(redactRecordForRole("projectRequests", { id: "request-a", proposedPrice: 45000 }, "product_manager")).not.toHaveProperty("proposedPrice");
  });
});
