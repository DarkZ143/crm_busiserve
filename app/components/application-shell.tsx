"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  Bell, Building2, ChartNoAxesCombined, ClipboardCheck, ClipboardList,
  FileClock, FolderKanban, LayoutDashboard, ListTodo, LogOut, Menu,
  MessageSquareText, Settings, Users, UsersRound, X,
  type LucideIcon,
} from "lucide-react";
import { BrandWordmark } from "@/app/components/auth-layout";
import type { RecordData, Role, SessionUser } from "@/lib/types";

type NavLink = { label: string; href: string; icon: LucideIcon };
const navigation: Record<Role, NavLink[]> = {
  super_admin: [
    { label: "Dashboard", href: "/admin/dashboard", icon: LayoutDashboard },
    { label: "User management", href: "/admin/users", icon: Users },
    { label: "Clients", href: "/admin/clients", icon: Building2 },
    { label: "Projects", href: "/admin/projects", icon: FolderKanban },
    { label: "Tasks", href: "/admin/tasks", icon: ListTodo },
    { label: "Work reports", href: "/admin/reports", icon: ClipboardCheck },
    { label: "Analytics", href: "/admin/analytics", icon: ChartNoAxesCombined },
    { label: "Audit log", href: "/admin/audit-logs", icon: FileClock },
    { label: "Notifications", href: "/admin/notifications", icon: Bell },
    { label: "Settings", href: "/admin/settings", icon: Settings },
  ],
  cto: [
    { label: "Dashboard", href: "/cto/dashboard", icon: LayoutDashboard },
    { label: "Clients", href: "/cto/clients", icon: Building2 },
    { label: "Project requests", href: "/cto/project-requests", icon: ClipboardList },
    { label: "Projects", href: "/cto/projects", icon: FolderKanban },
    { label: "Team", href: "/cto/team", icon: UsersRound },
    { label: "Tasks", href: "/cto/tasks", icon: ListTodo },
    { label: "Work reports", href: "/cto/reports", icon: ClipboardCheck },
    { label: "Milestones", href: "/cto/milestones", icon: FileClock },
    { label: "Notifications", href: "/cto/notifications", icon: Bell },
  ],
  product_manager: [
    { label: "Dashboard", href: "/product-manager/dashboard", icon: LayoutDashboard },
    { label: "Clients", href: "/product-manager/clients", icon: Building2 },
    { label: "Project requests", href: "/product-manager/project-requests", icon: ClipboardList },
    { label: "Projects", href: "/product-manager/projects", icon: FolderKanban },
    { label: "Updates", href: "/product-manager/updates", icon: MessageSquareText },
  ],
  team_member: [
    { label: "Dashboard", href: "/workspace/dashboard", icon: LayoutDashboard },
    { label: "My projects", href: "/workspace/projects", icon: FolderKanban },
    { label: "My tasks", href: "/workspace/tasks", icon: ListTodo },
    { label: "Daily reports", href: "/workspace/daily-reports", icon: ClipboardCheck },
    { label: "Work history", href: "/workspace/history", icon: FileClock },
    { label: "Notifications", href: "/workspace/notifications", icon: Bell },
  ],
};

const roleLabel: Record<Role, string> = {
  super_admin: "Super Admin",
  cto: "Chief Technology Officer",
  product_manager: "Product Manager",
  team_member: "Team member",
};

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "B";
}

export function ApplicationShell({
  user,
  title,
  section,
  description = "Keep project work visible, accountable, and moving forward.",
  headerActions,
  notifications,
  children,
}: {
  user: SessionUser;
  title: string;
  section: string;
  description?: string;
  headerActions?: ReactNode;
  notifications: RecordData[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const unreadCount = notifications.filter((notification) => !notification.readAt).length;

  async function logout() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.replace("/login");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="workspace-shell">
      <button className={`mobile-scrim ${menuOpen ? "open" : ""}`} type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="sidebar-brand"><BrandWordmark /></div>
        <div className="sidebar-label">Operations</div>
        <nav className="sidebar-nav" aria-label="Primary navigation">
          {navigation[user.role].map(({ label, href, icon: Icon }) => {
            const active = pathname === href || (href !== `/${pathname.split("/")[1]}/dashboard` && pathname.startsWith(`${href}/`));
            return (
              <Link key={href} className={`nav-link ${active ? "active" : ""}`} href={href} onClick={() => setMenuOpen(false)}>
                <Icon size={16} strokeWidth={1.8} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-profile">
          <div className="avatar" aria-hidden="true">{initials(user.displayName)}</div>
          <div className="profile-copy">
            <div className="profile-name" title={user.displayName}>{user.displayName}</div>
            <div className="profile-role">{user.designation || roleLabel[user.role]}</div>
          </div>
          <button className="signout-button" type="button" onClick={logout} disabled={signingOut} title="Sign out" aria-label="Sign out">
            <LogOut size={15} />
          </button>
        </div>
      </aside>
      <main className="workspace-main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-toggle" type="button" onClick={() => setMenuOpen((open) => !open)} aria-label={menuOpen ? "Close navigation" : "Open navigation"}>
              {menuOpen ? <X size={17} /> : <Menu size={17} />}
            </button>
            <span className="crumb">{roleLabel[user.role]}</span>
            <span className="crumb">/</span>
            <span className="crumb-current">{title}</span>
          </div>
          <div className="topbar-right">
            <span className="topbar-date">BUSISERVE WORKSPACE</span>
            <Link className="topbar-icon" href={user.role === "product_manager" ? "/product-manager/updates" : user.role === "super_admin" ? "/admin/notifications" : user.role === "cto" ? "/cto/notifications" : "/workspace/notifications"} aria-label="Notifications and account updates">
              <Bell size={16} strokeWidth={1.8} />
              {unreadCount > 0 && <span className="notification-dot" />}
            </Link>
          </div>
        </header>
        <div className="workspace-content">
          <div className="page-heading">
            <div>
              <div className="section-eyebrow">{section.replaceAll("-", " ")}</div>
              <h1>{title}</h1>
              <p>{description}</p>
            </div>
            {headerActions && <div className="heading-actions">{headerActions}</div>}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
