import type { ReactNode } from "react";

export function Badge({ children, className = "bg-yellow" }: { children: ReactNode; className?: string }) {
  return <span className={`nb-badge ${className}`}>{children}</span>;
}

export function Card({ children, className = "", hover = false }: { children?: ReactNode; className?: string; hover?: boolean }) {
  return <div className={`nb-card ${hover ? "nb-card-hover" : ""} ${className}`}>{children}</div>;
}

export function Kicker({ children, className = "bg-yellow" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-block border-[3px] border-black px-3 py-1 font-mono text-xs font-bold uppercase tracking-wider shadow-nb-sm ${className}`}>
      {children}
    </span>
  );
}

export function SectionTitle({ kicker, title, sub, kickerClass }: { kicker?: string; title: ReactNode; sub?: ReactNode; kickerClass?: string }) {
  return (
    <div className="mb-8 max-w-3xl">
      {kicker && <Kicker className={kickerClass}>{kicker}</Kicker>}
      <h2 className="mt-4 font-heading text-3xl font-bold leading-tight sm:text-4xl">{title}</h2>
      {sub && <p className="mt-3 text-lg text-muted">{sub}</p>}
    </div>
  );
}

export function Stat({ label, value, className = "bg-card" }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={`nb-card p-4 ${className}`}>
      <div className="font-display text-3xl font-extrabold leading-none sm:text-4xl">{value}</div>
      <div className="mt-2 font-mono text-xs font-bold uppercase tracking-wide">{label}</div>
    </div>
  );
}

export function Check({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  const icon = ok === null ? "…" : ok ? "✓" : "✗";
  const bg = ok === null ? "bg-paper" : ok ? "bg-green" : "bg-pink";
  return (
    <li className="flex items-start gap-3">
      <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center border-2 border-black font-mono text-sm font-bold ${bg}`}>{icon}</span>
      <span className="text-sm leading-6">{children}</span>
    </li>
  );
}

export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-4 sm:px-6 ${className}`}>{children}</div>;
}
