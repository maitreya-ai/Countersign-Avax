"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const LINKS = [
  { href: "/live", label: "Live" },
  { href: "/sellers", label: "Sellers" },
  { href: "/try", label: "Try it" },
  { href: "/protocol", label: "Protocol" },
];

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2" aria-label="Assay home">
      <span className="grid h-10 w-10 place-items-center border-[3px] border-black bg-yellow font-display text-xl font-extrabold shadow-nb-sm">A</span>
      <span className="font-display text-2xl font-extrabold tracking-tight">assay</span>
    </Link>
  );
}

export function Nav() {
  return <NavBar path={usePathname()} />;
}

/** Same bar without the active-link state: the prerendered fallback while the pathname streams in. */
export function NavFallback() {
  return <NavBar path="" />;
}

function NavBar({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b-[3px] border-black bg-paper">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Logo />
        <nav className="hidden items-center gap-2 md:flex">
          {LINKS.map((l) => {
            const active = path.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`border-[3px] px-3 py-1.5 font-heading font-bold transition-all ${active ? "border-black bg-black text-paper" : "border-transparent hover:border-black hover:bg-card hover:shadow-nb-sm"}`}
              >
                {l.label}
              </Link>
            );
          })}
          <Link href="/try" className="nb-btn nb-btn-sm ml-2 bg-pink">Run a purchase</Link>
        </nav>
        <button type="button" className="nb-btn nb-btn-sm bg-card md:hidden" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Menu">
          {open ? "Close" : "Menu"}
        </button>
      </div>
      {open && (
        <nav className="flex flex-col gap-2 border-t-[3px] border-black bg-card px-4 py-3 md:hidden">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="border-[3px] border-black px-3 py-2 font-heading font-bold shadow-nb-sm">
              {l.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
