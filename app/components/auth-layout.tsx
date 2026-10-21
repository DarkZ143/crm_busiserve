import type { ReactNode } from "react";

export function BrandWordmark() {
  return (
    <div className="brand-wordmark" aria-label="Busiserve">
      <span>BUSISERVE</span>
    </div>
  );
}

export function AuthLayout({ eyebrow, title, description, children }: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="auth-shell">
      <section className="auth-main">
        <div className="auth-inner">
          <BrandWordmark />
          <div className="auth-copy">
            <span className="eyebrow">{eyebrow}</span>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          {children}
          <div className="auth-footnote">Internal workspace <span>·</span> Secure access</div>
          <nav className="auth-policy-links" aria-label="Company policies">
            <a href="https://www.busiserve.in/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>
            <span aria-hidden="true">·</span>
            <a href="https://www.busiserve.in/terms" target="_blank" rel="noreferrer">Terms &amp; Conditions</a>
            <span aria-hidden="true">·</span>
            <a href="https://www.busiserve.in/refund-policy" target="_blank" rel="noreferrer">Refund &amp; Cancellation Policy</a>
          </nav>
        </div>
      </section>
      <aside className="auth-aside" aria-label="Platform overview">
        <div className="aside-grid" aria-hidden="true" />
        <div className="aside-orbit aside-orbit-one" aria-hidden="true" />
        <div className="aside-orbit aside-orbit-two" aria-hidden="true" />
        <div className="aside-content">
          <div className="aside-kicker"><span className="status-dot" /> COMPANY OPERATIONS</div>
          <h2>Good work moves<br />with clear ownership.</h2>
          <p>One secure place to coordinate clients, delivery teams, and the work behind every project.</p>
          <div className="aside-rule" />
          <div className="aside-caption">BUSISERVE INFOTECH SOLUTION</div>
        </div>
        <div className="aside-bottom">Project delivery · Team coordination · Business records</div>
      </aside>
    </main>
  );
}
