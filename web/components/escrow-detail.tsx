"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { useNode, type NodeEscrowExtras } from "@/lib/api";
import { decodeSettle, useChain, type DecodedSettle } from "@/lib/chain";
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

function Served({ text, title, tone, note }: { text: string; title: string; tone: string; note?: string }) {
  const ev = parseEvidence(text);
  const [showDoc, setShowDoc] = useState(false);
  return (
    <Card className={`p-5 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-lg font-bold">{title}</h3>
        <span className="font-mono text-xs">{ev.route} → {ev.status}</span>
      </div>
      {note && <p className="mt-1 font-mono text-[11px]">{note}</p>}
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

export function EscrowDetail({ id }: { id: string }) {
  const { escrows, status, error } = useChain();
  const e = escrows.find((x) => x.id.toLowerCase() === id.toLowerCase());
  const { data: node } = useNode<NodeEscrowExtras>(e && (e.state === "Open" || e.reason === "Equivocation" || !e.tx.settle) ? `/escrows/${id}` : null, 4000);
  const [settle, setSettle] = useState<DecodedSettle | null>(null);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [vErr, setVErr] = useState<string | null>(null);

  useEffect(() => {
    if (e?.tx.settle) decodeSettle(e.tx.settle as Hex).then(setSettle, () => setSettle(null));
  }, [e?.tx.settle]);

  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return <Card className="bg-pink p-6 font-mono text-sm">Not a valid purchase id.</Card>;
  if (status === "error" && !e) return <Card className="bg-orange p-6 font-mono text-sm">Avalanche RPC unreachable ({error}). Retrying…</Card>;
  if (!e) {
    return status === "ready"
      ? <Card className="bg-card p-6"><p className="font-heading font-bold">This purchase isn&apos;t on-chain yet.</p><p className="mt-1 text-sm">If it was just paid, it appears within a few seconds.</p></Card>
      : <Card className="h-64 animate-pulse bg-card" />;
  }

  const st = statusOf(e.state, e.reason, node?.job);
  const final = e.state === "Resolved" || e.state === "Refunded";
  const equivocated = e.reason === "Equivocation";
  const committedBody = settle?.evidence ?? node?.evidence.find((x) => x.hash.toLowerCase() === e.evidenceHash?.toLowerCase())?.body ?? null;
  const servedBody = node?.evidence.find((x) => x.hash.toLowerCase() !== e.evidenceHash?.toLowerCase())?.body ?? null;
  const steps = [
    { label: "USDC locked", tx: e.tx.open, done: Boolean(e.tx.open) },
    { label: "Evidence committed", tx: e.tx.evidence, done: Boolean(e.tx.evidence) },
    { label: equivocated ? "Equivocation proven" : e.reason === "DeadlineRefund" ? "Deadline refund" : "Verdict settled", tx: e.tx.settle ?? e.tx.final, done: Boolean(e.tx.settle ?? e.tx.final) },
    { label: "ERC-8004 record", tx: e.tx.record, done: Boolean(e.tx.record) },
  ];

  async function runVerify() {
    if (!e) return;
    setVerifying(true); setVErr(null); setChecks(null);
    try { setChecks(await verifyInBrowser(e, node)); } catch (err) { setVErr((err as Error).message.split("\n")[0] ?? "error"); }
    setVerifying(false);
  }

  return (
    <div className="space-y-8">
      <Card className="bg-card p-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`border-[3px] border-black px-3 py-1 font-heading text-xl font-bold ${sellerColor[e.seller ?? ""] ?? "bg-blue"}`}>{e.seller ?? "seller"}</span>
          <span className={`nb-badge ${st.bg} px-3 py-1 text-sm ${final ? "" : "nb-live"}`}>{st.label}</span>
          {e.score !== null && <Badge className="bg-lavender">ERC-8004 score {e.score}</Badge>}
          <span className="ml-auto font-display text-4xl font-extrabold">${usdc(e.amount)}</span>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 font-mono text-xs">
          <span>escrow</span><Copy value={e.id} label={short(e.id, 10)} />
          <span>block {e.openBlock.toString()}{e.createdAt ? ` · ${ago(e.createdAt)}` : ""}</span>
        </div>
        <ol className="mt-6 grid gap-3 sm:grid-cols-4">
          {steps.map((s, i) => {
            const active = !s.done && (i === 0 || steps[i - 1]!.done);
            return (
              <li key={s.label} className={`border-[3px] border-black p-3 ${s.done ? "bg-green" : active ? "nb-live bg-yellow" : "bg-paper"}`}>
                <div className="font-mono text-xs font-bold">STEP {i + 1}</div>
                <div className="font-heading font-bold">{s.label}</div>
                <div className="mt-1 [&_a]:text-black">{s.tx ? <TxLink hash={s.tx} /> : <span className="font-mono text-xs">{active ? (node?.job === "judging" && i === 2 ? "judges running…" : "waiting…") : ""}</span>}</div>
              </li>
            );
          })}
        </ol>
      </Card>

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
              {([["Open (gasless for buyer)", e.tx.open], ["Evidence + receipt", e.tx.evidence], ["Settle (verdict)", e.tx.settle], ["Equivocation / refund", e.tx.final], ["ERC-8004 record", e.tx.record]] as const).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3"><dt>{k}</dt><dd><TxLink hash={v} /></dd></div>
              ))}
            </dl>
            {settle?.gasUsed && <p className="mt-3 font-mono text-xs">settle gas used: {Number(settle.gasUsed).toLocaleString()}</p>}
          </Card>
        </div>
        <div className="min-w-0 space-y-6">
          {equivocated ? (
            <>
              {servedBody && <Served text={servedBody} title="What the buyer was served" tone="bg-pink" />}
              {committedBody && <Served text={committedBody} title="What the seller committed on-chain" tone="bg-lavender" />}
              <Card className="bg-black p-4 text-paper">
                <p className="text-sm">The seller signed receipts for <b>two different</b> responses to the same purchase. The buyer&apos;s receipt is the proof: the contract checked the seller&apos;s signature, refunded the buyer, and the seller&apos;s ERC-8004 record took a 0.</p>
                {!servedBody && <p className="mt-2 font-mono text-[11px] text-paper/70">Both responses are off-chain; only their hashes and the seller&apos;s signature are on-chain.</p>}
              </Card>
            </>
          ) : committedBody ? (
            <Served text={committedBody} title="What the seller served" tone="bg-card" note={settle?.evidence ? "decoded from the judges' signed requests in the settle transaction" : undefined} />
          ) : (
            <Card className="bg-card p-5"><p className="text-sm">{e.evidenceHash ? "Evidence committed. The judges are deciding…" : "Waiting for the seller's signed receipt…"}</p></Card>
          )}
        </div>
      </div>

      {settle && (
        <section>
          <h2 className="font-heading text-2xl font-bold">The judges</h2>
          <p className="mt-1 text-sm text-muted">Decoded from the settle transaction. Each verdict is signed over the exact model request and response bytes; the contract re-hashed them and recovered the signer.</p>
          <div className="mt-4 grid gap-5 md:grid-cols-2">
            {settle.attestations.map((a) => (
              <Card key={a.role} className="flex min-w-0 flex-col p-5">
                <div className="flex items-center gap-3">
                  <span className={`grid h-14 w-14 shrink-0 place-items-center border-[3px] border-black font-display text-3xl font-extrabold ${a.verdict === "Y" ? "bg-green" : a.verdict === "N" ? "bg-pink" : "bg-orange"}`}>{a.verdict}</span>
                  <div className="min-w-0">
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

      <Card className="bg-blue/40 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-heading text-2xl font-bold">Don&apos;t trust us. Verify it.</h2>
            <p className="mt-1 max-w-2xl text-sm">
              Your browser reads Avalanche directly. It decodes the settle calldata, re-hashes every byte with sha256,
              recovers each judge&apos;s key, re-applies the policy, and checks the ERC-8004 record.
            </p>
          </div>
          <button type="button" className="nb-btn bg-yellow" onClick={runVerify} disabled={verifying || !e.evidenceHash}>
            {verifying ? "Verifying…" : "Verify in browser"}
          </button>
        </div>
        {vErr && <p className="mt-4 font-mono text-sm">Error: {vErr}</p>}
        {checks && (
          <ul className="mt-6 grid gap-3 md:grid-cols-2">
            {checks.map((c, i) => (
              <Check key={i} ok={c.ok}>
                <b>{c.label}</b>
                {c.detail && <span className="block break-all font-mono text-xs text-muted">{c.detail}</span>}
              </Check>
            ))}
          </ul>
        )}
        {checks && (
          <p className="mt-5 font-heading font-bold">
            {checks.every((c) => c.ok) ? `✓ All ${checks.length} checks passed, from public data only.` : "Some checks failed. See above."}
          </p>
        )}
      </Card>

      <Link href="/live" className="nb-link">← Back to the live feed</Link>
    </div>
  );
}
