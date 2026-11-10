"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, type Address } from "viem";
import { fetchWithCountersign, getOffer, type Offer } from "@countersign/x402";
import { api, usePoll, useConfig, type SellerRow } from "@/lib/api";
import { ARTICLE } from "@/lib/article";
import { sellerBlurb, sellerColor, usdc } from "@/lib/format";
import { ScoreBar } from "./seller-board";
import { Badge, Card } from "./ui";

const NAMES = ["honest", "lazy", "injector", "swapper"];

declare global {
  interface Window { ethereum?: any }
}

export function TryIt() {
  const params = useSearchParams();
  const router = useRouter();
  const { cfg } = useConfig();
  const { data: sellers } = usePoll<{ sellers: SellerRow[] }>("/sellers", 8000);
  const [seller, setSeller] = useState(params.get("seller") ?? "honest");
  const [doc, setDoc] = useState(ARTICLE);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [offerErr, setOfferErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "demo" | "wallet">(null);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<{ escrowId?: string; response?: string; error?: string } | null>(null);

  const url = cfg ? `${cfg.sellersUrl}/${seller}/summarize` : null;
  const body = useMemo(() => JSON.stringify({ document: doc, bullets: 5 }), [doc]);
  const bytes = new TextEncoder().encode(body).length;
  const row = sellers?.sellers.find((s) => s.name === seller);

  useEffect(() => {
    if (!url) return;
    setOffer(null); setOfferErr(null);
    getOffer(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }).then(setOffer, (e) => setOfferErr((e as Error).message));
  }, [url, body]);

  const push = (m: string) => setLog((l) => [...l, m]);

  async function runDemo() {
    setBusy("demo"); setLog([]); setResult(null);
    push(`POST ${cfg?.nodeUrl}/demo/buy  { seller: "${seller}" }`);
    try {
      const r = await api<{ escrowId: string; response: string; log: string[] }>("/demo/buy", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seller, document: doc === ARTICLE ? undefined : doc }),
      });
      r.log.forEach(push);
      setResult({ escrowId: r.escrowId, response: r.response });
    } catch (e) {
      setResult({ error: (e as Error).message });
    }
    setBusy(null);
  }

  async function runWallet() {
    if (!cfg || !url) return;
    setBusy("wallet"); setLog([]); setResult(null);
    try {
      if (!window.ethereum) throw new Error("No browser wallet found. Install Core or MetaMask, or use the demo agent.");
      const chain = { id: cfg.chainId, name: "Avalanche Fuji", nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpc] } } } as const;
      const wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
      const [address] = await wallet.requestAddresses();
      push(`connected ${address}`);
      try { await wallet.switchChain({ id: cfg.chainId }); } catch { await wallet.addChain({ chain }); }
      const publicClient = createPublicClient({ chain, transport: http(cfg.rpc) });
      const p = await fetchWithCountersign(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }, {
        account: { wallet, account: address as Address }, publicClient: publicClient as any, prefer: "countersign", maxAmount: 2_000_000n, log: push,
        minTrust: { minCount: 1_000_000, minAvg: 0 },
      });
      setResult({ escrowId: p.escrowId, response: new TextDecoder().decode(p.body) });
    } catch (e) {
      setResult({ error: (e as Error).message });
    }
    setBusy(null);
  }

  const countersign = offer?.countersign;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-6">
        <Card className="bg-card p-5">
          <h3 className="font-heading text-lg font-bold">1 · Pick a seller</h3>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {NAMES.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => { setSeller(n); router.replace(`/try?seller=${n}`, { scroll: false }); }}
                className={`border-[3px] border-black p-3 text-left transition-all ${seller === n ? `${sellerColor[n]} shadow-nb` : "bg-paper hover:shadow-nb-sm"}`}
              >
                <div className="font-heading font-bold">{n}</div>
                <div className="mt-1 text-xs">{sellerBlurb[n]}</div>
              </button>
            ))}
          </div>
          {row && <div className="mt-5"><ScoreBar avg={row.record.avg} count={row.record.count} /></div>}
        </Card>

        <Card className="bg-card p-5">
          <div className="flex items-center justify-between">
            <h3 className="font-heading text-lg font-bold">2 · The request</h3>
            <span className={`font-mono text-xs ${bytes > 3000 ? "text-pink" : ""}`}>{bytes} / 3000 bytes</span>
          </div>
          <p className="mt-1 text-sm text-muted">POST {url ?? "…"} · these exact bytes become part of the evidence.</p>
          <textarea className="nb-input mt-3 h-44 w-full font-mono text-xs" value={doc} onChange={(e) => setDoc(e.target.value)} />
        </Card>

        <Card className="bg-card p-5">
          <h3 className="font-heading text-lg font-bold">3 · Pay, judged</h3>
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" className="nb-btn bg-yellow" onClick={runDemo} disabled={!!busy || !cfg?.demoEnabled || bytes > 3000}>
              {busy === "demo" ? "Buying…" : "Run with the demo agent"}
            </button>
            <button type="button" className="nb-btn bg-blue" onClick={runWallet} disabled={!!busy || bytes > 3000}>
              {busy === "wallet" ? "Waiting for wallet…" : "Pay with my wallet (gasless)"}
            </button>
          </div>
          <p className="mt-3 text-xs text-muted">
            The demo agent is a funded test wallet (one purchase every 20 s). Your own wallet needs Fuji USDC
            (<a className="nb-link" href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a>) and <b>no AVAX</b>: you sign once and the node submits it.
          </p>
          {log.length > 0 && (
            <pre className="nb-code mt-4 max-h-56 whitespace-pre-wrap">{log.map((l) => `› ${l}`).join("\n")}</pre>
          )}
          {result?.error && <p className="nb-card mt-4 bg-pink p-3 font-mono text-sm">{result.error}</p>}
          {result?.escrowId && (
            <div className="mt-4 space-y-3">
              <Card className="bg-green p-4">
                <div className="font-heading font-bold">USDC locked. The response is in. Now the judges decide.</div>
                <Link href={`/escrow/${result.escrowId}`} className="nb-btn nb-btn-sm mt-3 bg-card">Watch the verdict live →</Link>
              </Card>
              {result.response && <pre className="nb-code max-h-48 whitespace-pre-wrap">{result.response}</pre>}
            </div>
          )}
        </Card>
      </div>

      <div className="min-w-0 space-y-6">
        <Card className="bg-black p-5 text-paper">
          <div className="flex items-center justify-between">
            <h3 className="font-heading text-lg font-bold">The 402 offer, live from the seller</h3>
            <Badge className="bg-orange text-black">PAYMENT-REQUIRED</Badge>
          </div>
          {offerErr && <p className="mt-3 font-mono text-sm text-pink">{offerErr}</p>}
          {!offer && !offerErr && <p className="mt-3 font-mono text-sm text-paper/70">fetching…</p>}
          {offer?.exact && (
            <div className="mt-4 border-[3px] border-paper/40 p-3">
              <div className="flex justify-between font-mono text-sm"><b>exact</b><span>{usdc(offer.exact.amount)} USDC</span></div>
              <p className="mt-1 text-xs text-paper/70">{offer.exact.description}</p>
            </div>
          )}
          {countersign && (
            <div className="mt-3 border-[3px] border-green p-3">
              <div className="flex justify-between font-mono text-sm"><b className="text-green">countersign</b><span>{usdc(countersign.amount)} USDC</span></div>
              <dl className="mt-2 space-y-1 break-all font-mono text-[11px] leading-relaxed text-paper/85">
                <div><span className="text-yellow">rubric</span> &ldquo;{countersign.extra.rubric}&rdquo;</div>
                <div><span className="text-yellow">policy</span> {countersign.extra.policy.minAgree}/{countersign.extra.policy.judges} judges agree · grounded={String(countersign.extra.policy.requireGrounded)} · conf ≥ {countersign.extra.policy.minConfBps / 100}%</div>
                <div><span className="text-yellow">escrow</span> {countersign.extra.escrow}</div>
                <div><span className="text-yellow">agentId</span> #{countersign.extra.agentId ?? "-"} · <span className="text-yellow">validator</span> {countersign.extra.validator?.slice(0, 10)}…</div>
                <div><span className="text-yellow">deadline</span> {countersign.extra.deadlineSeconds}s · <span className="text-yellow">USDC domain</span> {countersign.extra.name} v{countersign.extra.version}</div>
              </dl>
            </div>
          )}
          {offer?.required && (
            <details className="mt-4">
              <summary className="cursor-pointer font-mono text-xs text-paper/70">raw JSON</summary>
              <pre className="mt-2 max-h-80 overflow-auto font-mono text-[11px] text-paper/80">{JSON.stringify(offer.required, null, 2)}</pre>
            </details>
          )}
        </Card>
        <Card className="bg-yellow p-5">
          <h3 className="font-heading text-lg font-bold">What happens when you pay</h3>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm">
            <li>You sign <code className="font-mono text-xs">ReceiveWithAuthorization</code>. Its nonce is the hash of these exact terms.</li>
            <li>The seller asks the node to open the escrow. Only the escrow can redeem your signature.</li>
            <li>The seller answers and signs a receipt over the exact bytes. Your browser checks it.</li>
            <li>Two judges, a grounding check and a calibration pass sign their verdicts. The contract verifies them.</li>
            <li>YES pays the seller. Anything else refunds you. The outcome goes into the seller&apos;s ERC-8004 record.</li>
          </ol>
        </Card>
      </div>
    </div>
  );
}
