"use client";

import Link from "next/link";
import { usePoll, type SellerRow } from "@/lib/api";
import { sellerBlurb, sellerColor } from "@/lib/format";
import { AddressLink } from "./hash";
import { Badge } from "./ui";

export function ScoreBar({ avg, count }: { avg: number; count: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between font-mono text-xs font-bold">
        <span>VERIFIED RECORD</span>
        <span>{count} judged</span>
      </div>
      <div className="mt-1 h-6 border-[3px] border-black bg-paper">
        <div className={`h-full border-r-[3px] border-black ${avg >= 80 ? "bg-green" : avg >= 40 ? "bg-orange" : "bg-pink"}`} style={{ width: `${count ? Math.max(avg, 3) : 0}%` }} />
      </div>
      <div className="mt-1 font-display text-2xl font-extrabold">{count ? `${avg}/100` : "no record"}</div>
    </div>
  );
}

export function SellerBoard({ compact = false }: { compact?: boolean }) {
  const { data, error } = usePoll<{ sellers: SellerRow[] }>("/sellers", 6000);
  if (error && !data) return <p className="nb-card bg-pink p-4 font-mono text-sm">Node offline: {error}</p>;
  const sellers = data?.sellers ?? [];
  const ranked = [...sellers].sort((a, b) => b.record.avg - a.record.avg || b.record.count - a.record.count);
  return (
    <div className={`grid gap-5 ${compact ? "sm:grid-cols-2 lg:grid-cols-4" : "md:grid-cols-2"}`}>
      {(data ? ranked : Array.from({ length: 4 }, () => null)).map((s, i) => (
        <div key={s?.name ?? i} className="nb-card nb-card-hover flex flex-col p-5">
          {s ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className={`border-[3px] border-black px-2 py-0.5 font-heading text-lg font-bold ${sellerColor[s.name] ?? "bg-blue"}`}>{s.name}</span>
                <span className="font-mono text-xs">agent #{s.agentId ?? "-"}</span>
              </div>
              <p className="mt-3 min-h-10 text-sm">{sellerBlurb[s.name] ?? s.resource}</p>
              <div className="mt-4"><ScoreBar avg={s.record.avg} count={s.record.count} /></div>
              {!compact && (
                <div className="mt-4 grid grid-cols-3 gap-2 text-center font-mono text-xs">
                  <div className="border-2 border-black p-1.5"><div className="text-lg font-bold">{s.sales.sales ?? 0}</div>sales</div>
                  <div className="border-2 border-black bg-green p-1.5"><div className="text-lg font-bold">{s.sales.paid ?? 0}</div>paid</div>
                  <div className="border-2 border-black bg-pink p-1.5"><div className="text-lg font-bold">{s.sales.refunded ?? 0}</div>refunded</div>
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {s.record.selfFiling ? <Badge className="bg-green">can't hide failures</Badge> : <Badge className="bg-orange">self-filing off</Badge>}
                {!compact && <AddressLink address={s.address} />}
              </div>
              {!compact && (
                <Link href={`/try?seller=${s.name}`} className="nb-btn nb-btn-sm mt-5 self-start bg-yellow">Buy from {s.name}</Link>
              )}
            </>
          ) : (
            <div className="h-40 animate-pulse bg-paper" />
          )}
        </div>
      ))}
    </div>
  );
}
