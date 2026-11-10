"use client";

import { usePoll, type Stats } from "@/lib/api";
import { usdc } from "@/lib/format";
import { Stat } from "./ui";

export function LiveStats() {
  const { data, error } = usePoll<Stats>("/stats", 4000);
  const v = (n: number | null | undefined) => (data ? String(n ?? 0) : "–");
  return (
    <div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Purchases judged" value={v(data?.escrows)} className="bg-card" />
        <Stat label="Paid (verified)" value={v(data?.paid)} className="bg-green" />
        <Stat label="Refunded" value={v(data?.refunded)} className="bg-pink" />
        <Stat label="Equivocations caught" value={v(data?.equivocations)} className="bg-lavender" />
        <Stat label="USDC protected" value={data ? `$${usdc(data.refunded_volume)}` : "–"} className="bg-yellow" />
      </div>
      <p className="mt-3 flex items-center gap-2 font-mono text-xs">
        <span className={`inline-block h-2.5 w-2.5 border-2 border-black ${error ? "bg-pink" : "nb-live bg-green"}`} />
        {error ? `node offline (${error})` : "live from the Assay node, refreshed every 4 s"}
      </p>
    </div>
  );
}
