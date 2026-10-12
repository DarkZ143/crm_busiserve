"use client";

import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, Save, Settings } from "lucide-react";

export function CompanySettings() {
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/settings")
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Settings could not be loaded.");
        if (active) setTimezone(result.settings.timezone);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Settings could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Settings could not be saved.");
      setMessage("Company timezone saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel settings-panel">
      <div className="panel-header"><div><div className="panel-title">Company timezone</div><div className="panel-subtitle">Used for work dates, daily reports, and dashboard summaries</div></div><span className="stat-icon"><Settings size={15} /></span></div>
      <form className="settings-form" onSubmit={save}>
        <label className="field-label" htmlFor="company-timezone">IANA timezone</label>
        <input className="text-input" id="company-timezone" name="timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Asia/Kolkata" required disabled={loading || saving} />
        <p className="settings-help">Use a timezone such as <code>Asia/Kolkata</code> or <code>Europe/London</code>. The server validates the value before saving.</p>
        {loading && <div className="settings-status">Loading current setting…</div>}
        {message && <div className="settings-success" role="status">{message}</div>}
        {error && <div className="form-error-inline" role="alert">{error}</div>}
        <div className="settings-actions"><button className="button button-primary" type="submit" disabled={loading || saving}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{saving ? "Saving…" : "Save timezone"}</button></div>
      </form>
    </section>
  );
}
