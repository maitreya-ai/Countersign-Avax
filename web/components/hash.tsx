"use client";

import { useState } from "react";
import { useConfig } from "@/lib/api";
import { short } from "@/lib/format";

export function TxLink({ hash, label }: { hash: string | null | undefined; label?: string }) {
  const { cfg } = useConfig();
  if (!hash) return <span className="font-mono text-sm text-muted">-</span>;
  const href = cfg?.explorer && cfg.chainId !== 31337 ? `${cfg.explorer}/tx/${hash}` : undefined;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="nb-link font-mono text-sm">{label ?? short(hash)} ↗</a>
  ) : (
    <span className="font-mono text-sm">{label ?? short(hash)}</span>
  );
}

export function AddressLink({ address, label }: { address: string | null | undefined; label?: string }) {
  const { cfg } = useConfig();
  if (!address) return <span className="font-mono text-sm text-muted">-</span>;
  const href = cfg?.explorer ? `${cfg.explorer}/address/${address}` : undefined;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="nb-link font-mono text-sm">{label ?? short(address, 4)} ↗</a>
  ) : (
    <span className="font-mono text-sm">{label ?? short(address, 4)}</span>
  );
}

export function Copy({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="nb-btn nb-btn-sm bg-card font-mono text-xs"
      onClick={() => { navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); }}
      title={value}
    >
      {done ? "copied" : label ?? short(value)}
    </button>
  );
}
