import Link from "next/link";
import { Activity, AlarmClock, BriefcaseBusiness, Building2, CheckCircle2, ClipboardCheck, ClipboardList, FolderKanban, ListTodo, UsersRound } from "lucide-react";
import { ApplicationShell } from "@/app/components/application-shell";
import { ProjectStatusChart } from "@/app/components/project-status-chart";
import type { RecordData, Role, SessionUser } from "@/lib/types";

type DashboardData = {
  clients: RecordData[];
  projects: RecordData[];
  projectRequests: RecordData[];
  tasks: RecordData[];
  workReports: RecordData[];
  notifications: RecordData[];
  auditLogs: RecordData[];
  users: RecordData[];
  timezone: string;
  totals: {
    activeClients: number;
    activeProjects: number;
    completedProjects: number;
    overdueProjects: number;
    pendingProjectRequests: number;
    changesRequested: number;
    reportsAwaitingReview: number;
    reportsToday: number;
    activeTeamMembers: number;
    openTasks: number;
    upcomingTasks: number;
    projectStatuses: { status: string; count: number }[];
  };
};

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function dateKey(value: unknown) {
  if (!value) return "";
  const date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? String(value).slice(0, 10) : date.toISOString().slice(0, 10);
}

function todayInTimezone(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function isOpen(value: unknown) {
  return !["completed", "cancelled", "accepted", "archived", "pending_approval", "rejected"].includes(text(value).toLowerCase());
}

const roleCopy: Record<Role, { title: string; section: string; description: string }> = {
  super_admin: { title: "Company overview", section: "Dashboard", description: "A current view of clients, delivery, and team activity." },
  cto: { title: "Operations overview", section: "Dashboard", description: "Review requests, delivery risk, and work awaiting your attention." },
  product_manager: { title: "Your portfolio", section: "Dashboard", description: "Follow onboarding, project decisions, and updates from delivery." },
  team_member: { title: "My workspace", section: "Dashboard", description: "See today’s assignments and keep your work reports current." },
};

function getStats(user: SessionUser, data: DashboardData) {
  if (user.role === "super_admin") return [
    { label: "Active clients", value: data.totals.activeClients, icon: Building2, foot: "Company-wide records" },
    { label: "Active projects", value: data.totals.activeProjects, icon: FolderKanban, foot: "Across all delivery teams" },
    { label: "Projects overdue", value: data.totals.overdueProjects, icon: AlarmClock, foot: "Past their expected end date" },
    { label: "Active team members", value: data.totals.activeTeamMembers, icon: UsersRound, foot: "Authorized workspace accounts" },
  ];
  if (user.role === "cto") return [
    { label: "Project requests", value: data.totals.pendingProjectRequests, icon: ClipboardList, foot: "Waiting for your decision" },
    { label: "Active projects", value: data.totals.activeProjects, icon: FolderKanban, foot: "Assigned to your portfolio" },
    { label: "Reports to review", value: data.totals.reportsAwaitingReview, icon: ClipboardCheck, foot: "Submitted by your teams" },
    { label: "Overdue projects", value: data.totals.overdueProjects, icon: AlarmClock, foot: "Need a delivery check-in" },
  ];
  if (user.role === "product_manager") return [
    { label: "My clients", value: data.totals.activeClients, icon: Building2, foot: "Created in your portfolio" },
    { label: "Awaiting CTO review", value: data.totals.pendingProjectRequests, icon: ClipboardList, foot: "Submitted project requests" },
    { label: "Active projects", value: data.totals.activeProjects, icon: FolderKanban, foot: "Projects you can follow" },
    { label: "Recent updates", value: data.notifications.filter((notification) => !notification.readAt).length, icon: Activity, foot: "Unread project notifications" },
  ];
  return [
    { label: "My projects", value: data.totals.activeProjects, icon: BriefcaseBusiness, foot: "Projects assigned to you" },
    { label: "Open tasks", value: data.totals.openTasks, icon: ListTodo, foot: "Tasks still in progress" },
    { label: "Reports today", value: data.totals.reportsToday, icon: ClipboardCheck, foot: "Submitted for today" },
    { label: "Upcoming deadlines", value: data.totals.upcomingTasks, icon: AlarmClock, foot: "Open tasks with a due date" },
  ];
}

function activity(data: DashboardData, role: Role) {
  if (role === "super_admin") return data.auditLogs.slice(0, 5).map((item) => ({
    title: `${text(item.actorName) || "Administrator"} · ${text(item.action).replaceAll("_", " ")}`,
    meta: `${text(item.targetCollection)} · ${text(item.createdAt).slice(0, 10)}`,
  }));
  return data.notifications.slice(0, 5).map((item) => ({
    title: text(item.title) || text(item.body),
    meta: `${text(item.createdAt).slice(0, 10)} · ${text(item.kind).replaceAll("_", " ")}`,
  }));
}

function upcoming(data: DashboardData, today: string) {
  const records = data.projects
    .filter((project) => isOpen(project.status) && dateKey(project.expectedEndDate ?? project.endDate) >= today)
    .sort((a, b) => dateKey(a.expectedEndDate ?? a.endDate).localeCompare(dateKey(b.expectedEndDate ?? b.endDate)))
    .slice(0, 4);
  return records;
}

export function DashboardContent({ user, data, titleOverride, sectionOverride }: { user: SessionUser; data: DashboardData; titleOverride?: string; sectionOverride?: string }) {
  const meta = roleCopy[user.role];
  const title = titleOverride ?? meta.title;
  const section = sectionOverride ?? meta.section;
  const today = todayInTimezone(data.timezone || "Asia/Kolkata");
  const stats = getStats(user, data);
  const events = activity(data, user.role);
  const deadlines = upcoming(data, today);
  const chart = data.totals.projectStatuses.map(({ status, count }) => ({
    status: status.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase()),
    count,
  }));
  const firstLink = user.role === "super_admin" ? "/admin/projects" : user.role === "cto" ? "/cto/project-requests" : user.role === "product_manager" ? "/product-manager/clients" : "/workspace/daily-reports";

  return (
    <ApplicationShell
      user={user}
      title={title}
      section={section}
      description={meta.description}
      headerActions={<Link className="button button-secondary" href={firstLink}>{user.role === "team_member" ? "Submit daily report" : user.role === "cto" ? "Review requests" : "View work"}</Link>}
      notifications={data.notifications}
    >
      <div className="stats-grid">
        {stats.map(({ label, value, icon: Icon, foot }) => (
          <article className="stat-card" key={label}>
            <div className="stat-top"><span>{label}</span><span className="stat-icon"><Icon size={15} strokeWidth={1.8} /></span></div>
            <div className="stat-value">{value}</div>
            <div className="stat-foot">{foot}</div>
          </article>
        ))}
      </div>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-header">
            <div><div className="panel-title">Project portfolio</div><div className="panel-subtitle">Current records by status</div></div>
            <Link className="panel-link" href={user.role === "super_admin" ? "/admin/projects" : user.role === "cto" ? "/cto/projects" : user.role === "product_manager" ? "/product-manager/projects" : "/workspace/projects"}>View projects</Link>
          </div>
          <div className="panel-body"><ProjectStatusChart data={chart} /></div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <div><div className="panel-title">{user.role === "super_admin" ? "Administrative activity" : "Recent updates"}</div><div className="panel-subtitle">Latest authorized activity</div></div>
          </div>
          <div className="panel-body">
            {events.length ? <div className="activity-list">{events.map((event, index) => <div className="activity-row" key={`${event.meta}-${index}`}><span className="activity-marker" /><div><div className="activity-text">{event.title}</div><div className="activity-meta">{event.meta}</div></div></div>)}</div> : (
              <div className="empty-state"><div><span className="empty-icon"><Activity size={17} /></span><h3>Nothing to review yet</h3><p>New actions and project updates will appear here when they happen.</p></div></div>
            )}
          </div>
        </section>
      </div>
      <section className="panel" style={{ marginTop: 15 }}>
        <div className="panel-header">
          <div><div className="panel-title">Upcoming project deadlines</div><div className="panel-subtitle">Ordered by expected end date</div></div>
          <Link className="panel-link" href={user.role === "super_admin" ? "/admin/projects" : user.role === "cto" ? "/cto/projects" : user.role === "product_manager" ? "/product-manager/projects" : "/workspace/projects"}>Open project list</Link>
        </div>
        {deadlines.length ? (
          <div className="table-scroll"><table className="data-table"><thead><tr><th>PROJECT</th><th>STATUS</th><th>EXPECTED END</th><th>PROGRESS</th></tr></thead><tbody>{deadlines.map((project) => <tr key={project.id}><td className="primary-cell">{text(project.name) || "Untitled project"}</td><td><span className={`status-badge status-${text(project.status)}`}>{text(project.status).replaceAll("_", " ") || "Unspecified"}</span></td><td>{dateKey(project.expectedEndDate ?? project.endDate) || "—"}</td><td>{typeof project.progressPercentage === "number" ? `${project.progressPercentage}%` : "—"}</td></tr>)}</tbody></table></div>
        ) : (
          <div className="empty-state"><div><span className="empty-icon"><CheckCircle2 size={17} /></span><h3>No upcoming deadlines</h3><p>Projects with an expected delivery date will be listed here.</p></div></div>
        )}
      </section>
    </ApplicationShell>
  );
}
