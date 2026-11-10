"use client";

import { chainStats, useChain } from "@/lib/chain";
import { usdc } from "@/lib/format";
import { Stat } from "./ui";

export function LiveStats() {
  const { status, escrows, error, head } = useChain();
  const s = chainStats(escrows);
  const ready = status === "ready";
  const v = (n: number) => (ready ? String(n) : "–");
  return (
    <div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Purchases judged" value={v(s.escrows)} className="bg-card" />
        <Stat label="Paid (verified)" value={v(s.paid)} className="bg-green" />
        <Stat label="Refunded" value={v(s.refunded)} className="bg-pink" />
        <Stat label="Equivocations caught" value={v(s.equivocations)} className="bg-lavender" />
        <Stat label="USDC protected" value={ready ? `$${usdc(s.refundedVolume)}` : "–"} className="bg-yellow" />
      </div>
      <p className="mt-3 flex items-center gap-2 font-mono text-xs">
        <span className={`inline-block h-2.5 w-2.5 border-2 border-black ${status === "error" ? "bg-pink" : "nb-live bg-green"}`} />
        {status === "error" ? `Avalanche RPC unreachable (${error}), retrying` : status === "loading" ? "reading Avalanche Fuji…" : `read directly from Avalanche Fuji · block ${head?.toString() ?? "…"}`}
      </p>
    </div>
  );
}
