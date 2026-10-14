import { describe, expect, it } from "vitest";
import { canReadRecord } from "../lib/access-control";
import { combineProjectMembers, directTeamOf, internSummary, isProjectReviewable, projectApprovalStatus, projectsHrefForRole, stringArray, teamMemberSummary } from "../lib/project-approval";
import { redactRecordForRole } from "../lib/record-security";

describe("project submissions", () => {
  it("lets every non-admin role follow the projects they submitted", () => {
    const submitted = { id: "p1", createdBy: "user-a", assignedTeam: [], assignedCto: "", assignedProductManager: "" };
    expect(canReadRecord("team_member", "user-a", "projects", submitted)).toBe(true);
    expect(canReadRecord("product_manager", "user-a", "projects", submitted)).toBe(true);
    expect(canReadRecord("cto", "user-a", "projects", submitted)).toBe(true);
    expect(canReadRecord("team_member", "user-b", "projects", submitted)).toBe(false);
    expect(canReadRecord("cto", "user-b", "projects", submitted)).toBe(false);
  });

  it("treats projects without an approval status as approved", () => {
    expect(projectApprovalStatus({ status: "planning" })).toBe("approved");
    expect(projectApprovalStatus({ status: "draft" })).toBe("approved");
    expect(projectApprovalStatus({ approvalStatus: "pending" })).toBe("pending");
    expect(projectApprovalStatus({ approvalStatus: "unexpected" })).toBe("approved");
  });

  it("allows review only while a submission is pending or rejected", () => {
    expect(isProjectReviewable({ approvalStatus: "pending" })).toBe(true);
    expect(isProjectReviewable({ approvalStatus: "rejected" })).toBe(true);
    expect(isProjectReviewable({ approvalStatus: "approved" })).toBe(false);
    expect(isProjectReviewable({})).toBe(false);
  });

  it("keeps approval and team details visible to the submitter", () => {
    const project = {
      id: "p1",
      approvalStatus: "approved",
      approvalComments: "Looks good",
      reviewedByName: "Admin",
      assignedTeamMembers: [{ uid: "m1", displayName: "Asha", designation: "Developer" }],
      contractPrice: 5000,
    };
    const teamView = redactRecordForRole("projects", project, "team_member");
    expect(teamView).toHaveProperty("assignedTeamMembers");
    expect(teamView).toHaveProperty("reviewedByName", "Admin");
    expect(teamView).toHaveProperty("approvalComments", "Looks good");
    expect(teamView).not.toHaveProperty("contractPrice");
  });

  it("summarizes team members without exposing account fields", () => {
    expect(teamMemberSummary("m1", { displayName: "Asha", designation: "QA", email: "a@example.com", accountStatus: "active" }))
      .toEqual({ uid: "m1", displayName: "Asha", designation: "QA" });
    expect(teamMemberSummary("m2", undefined)).toEqual({ uid: "m2", displayName: "m2", designation: "" });
  });

  it("links notifications to the submitter's own projects page", () => {
    expect(projectsHrefForRole("cto")).toBe("/cto/projects");
    expect(projectsHrefForRole("product_manager")).toBe("/product-manager/projects");
    expect(projectsHrefForRole("team_member")).toBe("/workspace/projects");
    expect(projectsHrefForRole(undefined)).toBe("/workspace/projects");
  });
});

describe("submitter-only project access", () => {
  it("hides commercial terms from a CTO who submitted a project led by another CTO", () => {
    const project = { id: "p1", createdBy: "cto-a", assignedCto: "cto-b", contractPrice: 9000, currency: "INR", name: "Portal" };
    expect(redactRecordForRole("projects", project, "cto", "cto-a")).not.toHaveProperty("contractPrice");
    expect(redactRecordForRole("projects", project, "cto", "cto-a")).toHaveProperty("name", "Portal");
    expect(redactRecordForRole("projects", project, "cto", "cto-b")).toHaveProperty("contractPrice", 9000);
  });
});

describe("teams and interns on projects", () => {
  it("treats every legacy assignment as direct", () => {
    expect(directTeamOf({ assignedTeam: ["a", "b"] })).toEqual(["a", "b"]);
    expect(directTeamOf({ assignedTeam: ["a", "b", "t1"], directAssignedTeam: ["a"] })).toEqual(["a"]);
    expect(directTeamOf({})).toEqual([]);
  });

  it("combines direct people with every linked team without duplicates", () => {
    const result = combineProjectMembers(["a"], [
      { memberUids: ["a", "b"], internIds: ["i1"] },
      { memberUids: ["c"], internIds: ["i1", "i2"] },
      {},
    ]);
    expect(result.userIds).toEqual(["a", "b", "c"]);
    expect(result.teamInternIds).toEqual(["i1", "i2"]);
  });

  it("summarizes interns without contact details", () => {
    expect(internSummary("BUS-INT-1", { internId: "BUS-INT-1", fullName: "Riya", role: "QA intern", email: "r@example.com", phone: "999" }))
      .toEqual({ id: "BUS-INT-1", internId: "BUS-INT-1", fullName: "Riya", role: "QA intern" });
  });

  it("ignores malformed ID lists", () => {
    expect(stringArray(["a", "", 3, "a", null, "b"])).toEqual(["a", "b"]);
    expect(stringArray("a,b")).toEqual([]);
  });
});
