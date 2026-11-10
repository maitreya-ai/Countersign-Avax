"use client";

import Link from "next/link";
import { useState } from "react";
import { usePoll, useConfig, type EscrowDetail as Detail } from "@/lib/api";
import { ago, sellerColor, short, statusOf, usdc } from "@/lib/format";
import { verifyInBrowser, type CheckResult } from "@/lib/verify";
import { AddressLink, Copy, TxLink } from "./hash";
import { Badge, Card, Check } from "./ui";

function parseEvidence(text: string) {
  const [head, rest] = text.split("\n\nRESPONSE ");
  const lines = (head ?? "").split("\n");
  const request = lines.slice(2).join("\n");
  const status = rest?.slice(0, rest.indexOf("\n")) ?? "";
  const response = rest?.slice(rest.indexOf("\n") + 1) ?? "";
  let bullets: string[] | null = null;
  try { bullets = JSON.parse(response).bullets ?? null; } catch { /* not JSON */ }
  let doc: string | null = null;
  try { doc = JSON.parse(request).document ?? null; } catch { /* not JSON */ }
  return { route: lines[1]?.replace(/^REQUEST /, "") ?? "", request, doc, status, response, bullets };
}

function Served({ text, title, tone }: { text: string; title: string; tone: string }) {
  const ev = parseEvidence(text);
  const [showDoc, setShowDoc] = useState(false);
  return (
    <Card className={`p-5 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-lg font-bold">{title}</h3>
        <span className="font-mono text-xs">{ev.route} → {ev.status}</span>
      </div>
      {ev.bullets ? (
        <ol className="mt-3 space-y-2">
          {ev.bullets.map((b, i) => (
            <li key={i} className="flex gap-3 border-2 border-black bg-card p-2 text-sm">
              <span className="font-mono font-bold">{i + 1}</span>
              <span className="whitespace-pre-wrap">{b}</span>
            </li>
          ))}
        </ol>
      ) : (
        <pre className="nb-code mt-3 whitespace-pre-wrap">{ev.response}</pre>
      )}
      {ev.doc && (
        <button type="button" onClick={() => setShowDoc(!showDoc)} className="nb-btn nb-btn-sm mt-4 bg-card">
          {showDoc ? "Hide" : "Show"} source document
        </button>
      )}
      {showDoc && ev.doc && <p className="mt-3 whitespace-pre-wrap border-2 border-black bg-paper p-3 text-sm">{ev.doc}</p>}
    </Card>
  );
}

const STEPS = [
  { key: "opened", label: "USDC locked" },
  { key: "evidence_committed", label: "Evidence committed" },
  { key: "settled", label: "Verdict settled" },
  { key: "erc8004_recorded", label: "ERC-8004 record" },
];

export function EscrowDetail({ id }: { id: string }) {
  const { data: e, error } = usePoll<Detail>(`/escrows/${id}`, 2500);
  const { cfg } = useConfig();
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [vErr, setVErr] = useState<string | null>(null);

  if (error && !e) return <Card className="bg-pink p-6 font-mono text-sm">{error}</Card>;
  if (!e) return <Card className="h-64 animate-pulse bg-card" />;

  const st = statusOf(e.state, e.reason, e.job);
  const committed = e.evidence.find((x) => x.hash.toLowerCase() === e.evidenceHash?.toLowerCase());
  const other = e.evidence.find((x) => x.hash.toLowerCase() !== e.evidenceHash?.toLowerCase());
  const equivocated = e.reason === "Equivocation";
  const done = (k: string) => e.events.find((x) => x.kind === k || (k === "settled" && (x.kind === "equivocation_proven" || x.kind === "deadline_refund")));
  const final = e.state === "Resolved" || e.state === "Refunded";

  async function runVerify() {
    if (!cfg || !e) return;
    setVerifying(true); setVErr(null); setChecks(null);
    try { setChecks(await verifyInBrowser(cfg, e)); } catch (err) { setVErr((err as Error).message); }
    setVerifying(false);
  }

  return (
    <div className="space-y-8">
      {/* header */}
      <Card className="bg-card p-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`border-[3px] border-black px-3 py-1 font-heading text-xl font-bold ${sellerColor[e.seller ?? ""] ?? "bg-blue"}`}>{e.seller ?? "seller"}</span>
          <span className={`nb-badge ${st.bg} px-3 py-1 text-sm ${final ? "" : "nb-live"}`}>{st.label}</span>
          {e.score !== null && <Badge className="bg-lavender">ERC-8004 score {e.score}</Badge>}
          <span className="ml-auto font-display text-4xl font-extrabold">${usdc(e.amount)}</span>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 font-mono text-xs">
          <span>escrow</span><Copy value={e.id} label={short(e.id, 10)} />
          <span>opened {ago(e.createdAt)}</span>
        </div>
        <ol className="mt-6 grid gap-3 sm:grid-cols-4">
          {STEPS.map((s, i) => {
            const ev = done(s.key);
            const label = s.key === "settled" && equivocated ? "Equivocation proven" : s.key === "settled" && e.reason === "DeadlineRefund" ? "Deadline refund" : s.label;
            const active = !ev && (i === 0 || done(STEPS[i - 1]!.key));
            return (
              <li key={s.key} className={`border-[3px] border-black p-3 ${ev ? "bg-green" : active ? "nb-live bg-yellow" : "bg-paper"}`}>
                <div className="font-mono text-xs font-bold">STEP {i + 1}</div>
                <div className="font-heading font-bold">{label}</div>
                <div className="mt-1 [&_a]:text-black">{ev?.tx ? <TxLink hash={ev.tx} /> : <span className="font-mono text-xs">{ev ? "✓" : active ? (e.job === "judging" && s.key === "settled" ? "judges running…" : "waiting…") : ""}</span>}</div>
              </li>
            );
          })}
        </ol>
      </Card>

      {/* promise + served */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="min-w-0 space-y-6">
          <Card className="bg-yellow p-5">
            <h3 className="font-heading text-lg font-bold">The seller&apos;s promise (rubric)</h3>
            <p className="mt-2 font-mono text-sm leading-relaxed">&ldquo;{e.rubric}&rdquo;</p>
          </Card>
          <Card className="bg-card p-5">
            <h3 className="font-heading text-lg font-bold">Terms (signed into the USDC nonce)</h3>
            <dl className="mt-3 space-y-2 text-sm">
              {[
                ["Buyer", <AddressLink key="b" address={e.payer} />],
                ["Seller", <AddressLink key="s" address={e.payee} />],
                ["Seller agent", <span key="a" className="font-mono">#{e.agentId ?? "none"}</span>],
                ["Deadline", <span key="d" className="font-mono">{new Date(e.deadline * 1000).toLocaleString()}</span>],
                ["Evidence hash", <span key="h" className="font-mono">{short(e.evidenceHash, 10)}</span>],
              ].map(([k, v], i) => (
                <div key={i} className="flex items-center justify-between gap-3 border-b-2 border-black/10 pb-1.5"><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
          </Card>
          <Card className="bg-card p-5">
            <h3 className="font-heading text-lg font-bold">Transactions</h3>
            <dl className="mt-3 space-y-2 text-sm">
              {[["Open (gasless for buyer)", e.tx.open], ["Evidence + receipt", e.tx.evidence], ["Settle (verdict)", e.tx.settle], ["Equivocation / refund", e.tx.final], ["ERC-8004 record", e.tx.record]].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3"><dt>{k}</dt><dd><TxLink hash={v} /></dd></div>
              ))}
            </dl>
            {e.settleGas && <p className="mt-3 font-mono text-xs">settle gas used: {Number(e.settleGas).toLocaleString()}</p>}
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          {equivocated && other && committed ? (
            <>
              <Served text={other.body} title="What the buyer was served" tone="bg-pink" />
              <Served text={committed.body} title="What the seller committed on-chain" tone="bg-lavender" />
              <Card className="bg-black p-4 text-paper">
                <p className="text-sm">The seller signed receipts for <b>two different</b> responses to the same purchase. The buyer&apos;s receipt is proof, so the contract refunded the buyer and the seller&apos;s ERC-8004 record took a 0.</p>
              </Card>
            </>
          ) : committed ? (
            <Served text={committed.body} title="What the seller served" tone="bg-card" />
          ) : (
            <Card className="bg-card p-5"><p className="text-sm">Waiting for the seller&apos;s signed receipt…</p></Card>
          )}
        </div>
      </div>

      {/* judges */}
      {e.verdict && (
        <section>
          <h2 className="font-heading text-2xl font-bold">The judges</h2>
          <p className="mt-1 text-sm text-muted">Each verdict is signed over the exact model request and response bytes. The contract re-hashes them and recovers the signer.</p>
          <div className="mt-4 grid gap-5 md:grid-cols-2">
            {e.verdict.attestations.map((a) => (
              <Card key={a.role} className="flex flex-col p-5">
                <div className="flex items-center gap-3">
                  <span className={`grid h-14 w-14 place-items-center border-[3px] border-black font-display text-3xl font-extrabold ${a.verdict === "Y" ? "bg-green" : a.verdict === "N" ? "bg-pink" : "bg-orange"}`}>{a.verdict}</span>
                  <div>
                    <div className="font-heading text-lg font-bold capitalize">{a.role}</div>
                    <div className="font-mono text-xs">{a.model} · conf {a.conf.toFixed(2)}</div>
                  </div>
                </div>
                <p className="mt-4 flex-1 whitespace-pre-wrap text-sm leading-relaxed">{a.rationale || "(no rationale)"}</p>
                <div className="mt-4 border-t-2 border-black pt-2 font-mono text-[11px] text-muted">
                  signer {short(a.signer, 6)} · signed {a.signedText.slice(0, 14)}…:{a.signedText.slice(65, 75)}…
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* verify */}
      <Card className="bg-blue/40 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-heading text-2xl font-bold">Don&apos;t trust us. Verify it.</h2>
            <p className="mt-1 max-w-2xl text-sm">
              Your browser reads the chain directly. It decodes the settle calldata, re-hashes every byte with sha256,
              recovers each judge&apos;s key, re-applies the policy, and checks the ERC-8004 record.
            </p>
          </div>
          <button type="button" className="nb-btn bg-yellow" onClick={runVerify} disabled={verifying || !cfg || !e.evidenceHash}>
            {verifying ? "Verifying…" : "Verify in browser"}
          </button>
        </div>
        {vErr && <p className="mt-4 font-mono text-sm text-black">Error: {vErr}</p>}
        {checks && (
          <ul className="mt-6 grid gap-3 md:grid-cols-2">
            {checks.map((c, i) => (
              <Check key={i} ok={c.ok}>
                <b>{c.label}</b>
                {c.detail && <span className="block font-mono text-xs text-muted">{c.detail}</span>}
              </Check>
            ))}
          </ul>
        )}
        {checks && (
          <p className="mt-5 font-heading font-bold">
            {checks.every((c) => c.ok) ? "✓ Every check passed, from public data only." : "Some checks failed. See above."}
          </p>
        )}
      </Card>

      <Link href="/live" className="nb-link">← Back to the live feed</Link>
    </div>
  );
}
