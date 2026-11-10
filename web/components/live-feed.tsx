"use client";

import Link from "next/link";
import { usePoll, type EscrowSummary } from "@/lib/api";
import { ago, sellerColor, short, statusOf, usdc } from "@/lib/format";
import { TxLink } from "./hash";

const EVENT_LABEL: Record<string, string> = {
  opened: "USDC locked (gasless)",
  evidence_received: "Receipt received",
  evidence_committed: "Evidence committed on-chain",
  judging: "Judges running",
  settled: "Verdict settled on-chain",
  equivocation_proven: "Equivocation proven, buyer refunded",
  deadline_refund: "Deadline refund",
  arbitrated: "Arbiter decided",
  erc8004_recorded: "ERC-8004 record written",
  judge_error: "Judge error (will retry)",
};

export function LiveFeed() {
  const { data, error } = usePoll<{ escrows: EscrowSummary[] }>("/escrows?limit=60", 2500);
  const { data: act } = usePoll<{ events: { escrow_id: string; kind: string; tx: string | null; detail: string | null; at: number }[] }>("/activity?limit=25", 2500);
  const rows = data?.escrows ?? [];
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        {error && !data && <p className="nb-card mb-4 bg-pink p-4 font-mono text-sm">Node offline: {error}</p>}
        {data && rows.length === 0 && (
          <div className="nb-card bg-card p-8 text-center">
            <p className="font-heading text-xl font-bold">No purchases yet.</p>
            <Link href="/try" className="nb-btn mt-4 bg-pink">Run the first one</Link>
          </div>
        )}
        <div className="space-y-4">
          {rows.map((e) => {
            const st = statusOf(e.state, e.reason, e.job);
            return (
              <Link key={e.id} href={`/escrow/${e.id}`} className="nb-card nb-card-hover block p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`border-[3px] border-black px-2 py-0.5 font-heading font-bold ${sellerColor[e.seller ?? ""] ?? "bg-blue"}`}>{e.seller ?? short(e.payee, 4)}</span>
                  <span className={`nb-badge ${st.bg} ${e.state === "Open" ? "nb-live" : ""}`}>{st.label}</span>
                  {e.score !== null && <span className="nb-badge bg-card">ERC-8004 · {e.score}</span>}
                  <span className="ml-auto font-display text-xl font-extrabold">${usdc(e.amount)}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs text-muted">
                  <span>escrow {short(e.id, 8)}</span>
                  <span>buyer {short(e.payer, 4)}</span>
                  {e.settleGas && <span>settle gas {Number(e.settleGas).toLocaleString()}</span>}
                  <span className="ml-auto">{ago(e.createdAt)}</span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
      <aside className="min-w-0">
        <div className="nb-card sticky top-24 bg-black p-4 text-paper">
          <div className="flex items-center gap-2 font-mono text-xs font-bold uppercase text-yellow">
            <span className="nb-live inline-block h-2.5 w-2.5 bg-green" /> Activity
          </div>
          <ol className="mt-3 max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            {(act?.events ?? []).map((ev, i) => (
              <li key={i} className="border-l-[3px] border-yellow pl-3">
                <div className="text-sm font-bold">{EVENT_LABEL[ev.kind] ?? ev.kind}</div>
                <div className="font-mono text-[11px] text-paper/70">
                  <Link className="underline" href={`/escrow/${ev.escrow_id}`}>{short(ev.escrow_id, 6)}</Link> · {ago(ev.at)}
                </div>
                {ev.detail && <div className="mt-0.5 break-all font-mono text-[11px] text-paper/60">{ev.detail}</div>}
                {ev.tx && <div className="[&_a]:text-paper"><TxLink hash={ev.tx} /></div>}
              </li>
            ))}
            {act && act.events.length === 0 && <li className="text-sm text-paper/70">Waiting for the first purchase…</li>}
          </ol>
        </div>
      </aside>
    </div>
  );
}

export { EVENT_LABEL };
