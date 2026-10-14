import { Suspense } from "react";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { ApplicationShell } from "@/app/components/application-shell";
import { DashboardContent } from "@/app/components/dashboard-content";
import { WorkspaceLoader } from "@/app/components/workspace-loader";
import { WorkspaceSection } from "@/app/components/workspace-section";
import { canAccessArea } from "@/lib/access-control";
import { getSessionUser } from "@/lib/auth";
import { dateInTimezone, getCompanyTimezone, getDashboardRecords, getTeamWorkSummary, listRecords } from "@/lib/data";
import { isFirebaseConfigured } from "@/lib/firebase-admin";
import type { CollectionName, Role, SessionUser } from "@/lib/types";

type PageParameters = { params: Promise<{ area: string; section?: string[] }> };

const roleHome: Record<Role, string> = {
  super_admin: "/admin/dashboard",
  cto: "/cto/projects",
  product_manager: "/product-manager/projects",
  team_member: "/workspace/projects",
};

const titleBySection: Record<string, string> = {
  dashboard: "Dashboard",
  users: "User management",
  clients: "Clients",
  projects: "Projects",
  tasks: "Tasks",
  reports: "Work reports",
  "daily-reports": "Work report",
  history: "Work history",
  analytics: "Analytics",
  "audit-logs": "Audit log",
  settings: "Company settings",
  "project-requests": "Project requests",
  team: "Team allocation",
  milestones: "Milestones",
  updates: "Project updates",
  notifications: "Notifications",
  interns: "Interns",
  employees: "Full-time Employees",
  teams: "Team Management",
};

function sectionCollection(section: string): CollectionName | null {
  if (section === "clients") return "clients";
  if (section === "projects") return "projects";
  if (section === "tasks") return "tasks";
  if (section === "milestones") return "milestones";
  if (section === "reports" || section === "daily-reports" || section === "history") return "workReports";
  if (section === "project-requests") return "projectRequests";
  if (section === "users" || section === "team") return "users";
  if (section === "audit-logs") return "auditLogs";
  if (section === "interns") return "interns";
  if (section === "employees") return "users";
  if (section === "teams") return "teams";
  if (section === "updates" || section === "notifications") return "notifications";
  return null;
}

function allowedSection(area: string, section: string, role: Role) {
  if (role === "team_member") return area === "workspace" && ["projects", "daily-reports", "settings"].includes(section);
  if (role !== "super_admin") return section === "clients" || section === "projects";
  const common = ["dashboard"];
  const areas: Record<string, string[]> = {
    admin: ["users", "interns", "employees", "teams", "clients", "projects", "tasks", "reports", "analytics", "audit-logs", "settings", "notifications"],
    cto: ["clients", "project-requests", "projects", "team", "tasks", "reports", "milestones", "notifications"],
    "product-manager": ["clients", "projects", "project-requests", "updates"],
    workspace: ["projects", "clients", "tasks", "daily-reports", "history", "notifications"],
  };
  if (common.includes(section)) return true;
  if (!areas[area]?.includes(section)) return false;
  return true;
}

export default function WorkspaceRoute(props: PageParameters) {
  return (
    <Suspense fallback={<WorkspaceLoader />}>
      <WorkspaceRouteContent {...props} />
    </Suspense>
  );
}

async function WorkspaceRouteContent({ params }: PageParameters) {
  await connection();
  if (!isFirebaseConfigured()) redirect("/setup");
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { area, section: routeParts = [] } = await params;
  const section = routeParts[0] || "dashboard";
  const nestedAction = routeParts[1] || "";
  if (!canAccessArea(user.role, area)) redirect(roleHome[user.role]);
  if (!allowedSection(area, section, user.role)) notFound();
  if (nestedAction === "new" && user.role !== "super_admin" && section !== "clients" && section !== "projects") notFound();

  const title = nestedAction === "new"
    ? `New ${titleBySection[section]?.toLowerCase() ?? "record"}`
    : user.role === "team_member" && section === "projects"
      ? "My projects"
      : user.role === "team_member" && section === "settings"
        ? "Settings"
        : titleBySection[section];
  if (!title) notFound();

  if (section === "dashboard" || section === "analytics") {
    const data = await getDashboardRecords(user);
    if (section === "dashboard") return <DashboardContent user={user} data={data} />;
    return <DashboardContent user={user} data={data} titleOverride={title} sectionOverride={section} />;
  }

  const collection = sectionCollection(section);
  const [allRecords, auxiliary, timezone, teamWorkSummary] = await Promise.all([
    collection ? listRecords(collection, user) : Promise.resolve([]),
    getAuxiliaryRecords(section, user),
    getCompanyTimezone(),
    section === "reports" && user.role === "super_admin" ? getTeamWorkSummary() : Promise.resolve([]),
  ]);
  const records = section === "employees" ? allRecords.filter((record) => record.role === "team_member") : allRecords;
  return (
    <ApplicationShell user={user} title={title} section={section} notifications={auxiliary.notifications}>
      <WorkspaceSection
        key={section}
        user={user}
        section={section}
        collection={collection}
        records={records}
        auxiliary={auxiliary}
        companyDate={dateInTimezone(timezone)}
        teamWorkSummary={teamWorkSummary}
        initialNewRecord={nestedAction === "new"}
      />
    </ApplicationShell>
  );
}

async function getAuxiliaryRecords(section: string, user: SessionUser) {
  const empty: Record<"clients" | "projects" | "tasks" | "users" | "requests" | "notifications" | "interns" | "teams", Awaited<ReturnType<typeof listRecords>>> = {
    clients: [], projects: [], tasks: [], users: [], requests: [], notifications: [], interns: [], teams: [],
  };
  const lookups: Record<string, (keyof typeof empty)[]> = {
    "project-requests": ["clients"],
    projects: user.role === "super_admin" ? ["clients", "requests", "users", "teams"] : ["clients"],
    interns: ["projects", "teams", "users"],
    employees: ["interns", "teams"],
    teams: ["projects", "users", "interns"],
    tasks: ["projects", "users"],
    "daily-reports": ["projects", "tasks"],
    milestones: ["projects"],
    history: ["projects"],
    reports: ["projects"],
    users: [],
    team: [],
    clients: user.role === "super_admin" ? ["users"] : [],
    notifications: [],
    updates: [],
  };
  const keys = lookups[section] ?? [];
  const collectionByKey: Record<keyof typeof empty, CollectionName> = {
    clients: "clients", projects: "projects", tasks: "tasks", users: "users", requests: "projectRequests", notifications: "notifications", interns: "interns", teams: "teams",
  };
  const pairs = await Promise.all(keys.map(async (key) => [key, await listRecords(collectionByKey[key], user)] as const));
  const result = { ...empty, notifications: user.role === "super_admin" ? await listRecords("notifications", user) : [] };
  for (const [key, records] of pairs) result[key] = records;
  return result;
}
