"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface ProjectStatusPoint {
  status: string;
  count: number;
}

export function ProjectStatusChart({ data }: { data: ProjectStatusPoint[] }) {
  if (data.length === 0) {
    return (
      <div className="empty-state">
        <div>
          <span className="empty-icon">—</span>
          <h3>No project data yet</h3>
          <p>Project status activity will appear here when records are added.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chart-wrap" role="img" aria-label="Projects by current status">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 2 }}>
          <CartesianGrid vertical={false} stroke="#e4ebf3" strokeDasharray="3 3" />
          <XAxis dataKey="status" axisLine={false} tickLine={false} tick={{ fill: "#70819a", fontSize: 9 }} />
          <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: "#8998ab", fontSize: 9 }} />
          <Tooltip cursor={{ fill: "#f0f5fb" }} contentStyle={{ border: "1px solid #dce4ee", borderRadius: 8, fontSize: 11, boxShadow: "0 8px 22px rgb(4 25 53 / 10%)" }} />
          <Bar dataKey="count" name="Projects" fill="#ff8926" radius={[5, 5, 0, 0]} maxBarSize={44} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
