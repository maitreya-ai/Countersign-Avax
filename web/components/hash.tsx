"use client";

import { useState } from "react";
import { CONFIG } from "@/lib/config";
import { short } from "@/lib/format";

export function TxLink({ hash, label }: { hash: string | null | undefined; label?: string }) {
  if (!hash) return <span className="font-mono text-sm text-muted">-</span>;
  return (
    <a href={`${CONFIG.explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="nb-link font-mono text-sm">{label ?? short(hash)} ↗</a>
  );
}

export function AddressLink({ address, label }: { address: string | null | undefined; label?: string }) {
  if (!address) return <span className="font-mono text-sm text-muted">-</span>;
  return (
    <a href={`${CONFIG.explorer}/address/${address}`} target="_blank" rel="noreferrer" className="nb-link font-mono text-sm">{label ?? short(address, 4)} ↗</a>
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
