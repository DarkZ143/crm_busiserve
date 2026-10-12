"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole } from "lucide-react";

function SubmitButton({ children, pending }: { children: string; pending: boolean }) {
  return (
    <button className="button button-primary button-wide" type="submit" disabled={pending}>
      {pending ? <LoaderCircle size={17} className="spin" /> : <>{children}<ArrowRight size={16} /></>}
    </button>
  );
}

export function LoginForm({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Sign in could not be completed.");
      router.replace("/");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign in could not be completed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      {!configured && (
        <div className="notice notice-warning" role="status">
          <LockKeyhole size={17} />
          <span>Firebase is not configured yet. Complete the server setup before signing in.</span>
        </div>
      )}
      <label className="field-label" htmlFor="email">Work email</label>
      <input className="text-input" id="email" name="email" type="email" autoComplete="username" placeholder="name@company.com" required disabled={!configured || pending} />
      <div className="field-label-row">
        <label className="field-label" htmlFor="password">Password</label>
        <Link className="inline-link" href="/forgot-password">Forgot password?</Link>
      </div>
      <div className="password-field">
        <input className="text-input" id="password" name="password" type={visible ? "text" : "password"} autoComplete="current-password" placeholder="Enter your password" required disabled={!configured || pending} />
        <button className="password-toggle" type="button" onClick={() => setVisible((value) => !value)} aria-label={visible ? "Hide password" : "Show password"}>
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <SubmitButton pending={pending}>Sign in securely</SubmitButton>
      <p className="form-helper">Access is provisioned by your company administrator.</p>
    </form>
  );
}

export function ForgotPasswordForm({ configured }: { configured: boolean }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "We could not process that request.");
      setMessage(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "We could not process that request.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <label className="field-label" htmlFor="recovery-email">Work email</label>
      <input className="text-input" id="recovery-email" name="email" type="email" autoComplete="email" placeholder="name@company.com" required disabled={!configured || pending} />
      {message && <div className="notice notice-success" role="status">{message}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <SubmitButton pending={pending}>Send recovery email</SubmitButton>
      <Link className="back-link" href="/login"><ArrowLeft size={15} /> Back to sign in</Link>
    </form>
  );
}

