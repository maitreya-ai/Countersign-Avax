// HTTP API of the countersign node, independent of the host (Bun server or Cloudflare Durable Object).
// Routes: x402 facilitator, evidence intake, read API, pay-per-verdict /judge, rate-limited demo
// purchases, and (optionally) the demo sellers' paid endpoints.

import { CORS_HEADERS, REASON_NAMES, STATE_NAMES, VALIDATION_TAG_STRING, validationRegistryAbi, validatorAbi } from "@countersign/x402";
import { CHAIN_ID, EXPLORER, JUDGES, MODELS, RPC_URL, account, publicClient } from "@countersign/core";
import { buyFrom, SELLER_NAMES } from "@countersign/agent";
import { basePath, cfg, keeper, loopbackFetch } from "./ctx";
import { getDeployment } from "./deployment";
import { facilitatorSettle, facilitatorVerify, supported } from "./facilitator";
import { judgeRoute } from "./judgeApi";
import { acceptEvidence, kick } from "./keeper";
import { sql, store, type EscrowRow } from "./store";

export type Handler = (req: Request) => Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });

function sellerName(payee: string | null): string | null {
  if (!payee) return null;
  return getDeployment().sellers?.find((s) => s.address?.toLowerCase() === payee.toLowerCase())?.name ?? null;
}

function view(r: EscrowRow) {
  return {
    id: r.id, payer: r.payer, payee: r.payee, amount: r.amount, deadline: r.deadline, rubric: r.rubric,
    agentId: r.agent_id, seller: r.seller ?? sellerName(r.payee), resource: r.resource,
    state: STATE_NAMES[r.state] ?? "None", reason: REASON_NAMES[r.reason] ?? "None",
    outcome: r.outcome === null || r.outcome === undefined ? null : ["NO", "YES", "ESCALATE"][r.outcome],
    evidenceHash: r.evidence_hash, score: r.score, recordError: r.record_error?.replace(/^retry:/, "") ?? null,
    tx: { open: r.open_tx, evidence: r.evidence_tx, settle: r.settle_tx, final: r.final_tx, record: r.record_tx },
    settleGas: r.settle_gas, job: store.job(r.id)?.status ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

async function sellers() {
  return Promise.all((getDeployment().sellers ?? []).map(async (s) => {
    let count = 0, avg = 0, selfFiling = false;
    if (cfg.validator && cfg.validation && s.agentId) {
      const [sum, sf] = await Promise.all([
        publicClient.readContract({ address: cfg.validation, abi: validationRegistryAbi, functionName: "getSummary", args: [BigInt(s.agentId), [cfg.validator], VALIDATION_TAG_STRING] }),
        publicClient.readContract({ address: cfg.validator, abi: validatorAbi, functionName: "canSelfFile", args: [BigInt(s.agentId)] }).catch(() => false),
      ]).catch(() => [[0n, 0], false] as const);
      count = Number(sum[0]); avg = Number(sum[1]); selfFiling = sf as boolean;
    }
    const local = sql.get<any>(`SELECT COUNT(*) AS sales, SUM(CASE WHEN reason = 1 THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN reason IN (2, 6) THEN 1 ELSE 0 END) AS refunded FROM escrows WHERE lower(payee) = lower(?)`, s.address);
    return { ...s, record: { count, avg, selfFiling }, sales: local };
  }));
}

// ---- demo purchases (rate-limited; uses the node operator's demo agent wallet) ----------------

let lastDemo = 0;
async function demoBuy(name: string, document?: string) {
  if (!cfg.demoEnabled) return json({ error: "demo purchases are disabled on this node" }, 403);
  if (!SELLER_NAMES.includes(name as any)) return json({ error: `unknown seller ${name}` }, 400);
  if (document !== undefined && (typeof document !== "string" || document.length < 40 || document.length > 2600)) {
    return json({ error: "document must be 40 to 2600 characters" }, 400);
  }
  const wait = 20_000 - (Date.now() - lastDemo);
  if (wait > 0) return json({ error: `one demo purchase every 20 s; try again in ${Math.ceil(wait / 1000)} s` }, 429);
  lastDemo = Date.now();
  const lines: string[] = [];
  try {
    const p = await buyFrom(cfg.sellersUrl, name, {
      account: account("AGENT_PRIVATE_KEY"), publicClient, log: (m) => lines.push(m), document, fetch: loopbackFetch,
    });
    kick();
    return json({ seller: name, escrowId: p.escrowId, status: p.response.status, receiptValid: p.receiptValid, payment: p.payment, response: new TextDecoder().decode(p.body), log: lines });
  } catch (e) {
    return json({ error: (e as Error).message, log: lines }, 502);
  }
}

// ---- router ------------------------------------------------------------------------------------

export function createApp(opts: { sellerRoutes?: Map<string, Handler> | null } = {}): Handler {
  const sellerRoutes = opts.sellerRoutes ?? null;
  return async (req: Request) => {
    const url = new URL(req.url);
    // route on the path below the public base ("/api" on Cloudflare); sellers get the request
    // unchanged, so the path they sign into the evidence is the one the buyer actually called
    const base = basePath();
    const p = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) || "/" : url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const sellerRoute = sellerRoutes?.get(p);
    if (sellerRoute) return sellerRoute(req);
    try {
      if (p === "/" || p === "/health") {
        return json({ ok: true, service: "countersign-node", chainId: CHAIN_ID, escrow: cfg.escrow, validator: cfg.validator ?? null, keeper: keeper().account.address });
      }
      if (p === "/config") {
        const d = getDeployment();
        return json({
          chainId: CHAIN_ID, rpc: process.env.PUBLIC_RPC_URL ?? RPC_URL, explorer: EXPLORER, network: cfg.network,
          contracts: { usdc: cfg.usdc, escrow: cfg.escrow, oracle: cfg.oracle, signerRegistry: cfg.registry, validator: cfg.validator ?? null, identityRegistry: cfg.identity ?? null, validationRegistry: cfg.validation ?? null },
          judges: { count: JUDGES, models: MODELS }, sellers: d.sellers ?? [], sellersUrl: cfg.sellersUrl, nodeUrl: cfg.publicUrl,
          demoEnabled: cfg.demoEnabled, judgePrice: cfg.judgePrice.toString(), deployBlock: d.deployBlock ?? null,
        });
      }
      if (p === "/facilitator/supported" || p === "/supported") return json(supported());
      if (p === "/facilitator/verify" && req.method === "POST") return json(await facilitatorVerify(await req.json()));
      if (p === "/facilitator/settle" && req.method === "POST") return json(await facilitatorSettle(await req.json()));
      if (p === "/evidence" && req.method === "POST") {
        const r = await acceptEvidence(await req.json());
        return json(r.body, r.status);
      }
      if (p === "/escrows") {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
        return json({ escrows: store.list(limit).map(view) });
      }
      const m = p.match(/^\/escrows\/(0x[0-9a-fA-F]{64})$/);
      if (m) {
        const row = store.get(m[1]!.toLowerCase()) ?? store.get(m[1]!);
        if (!row) return json({ error: "unknown escrow" }, 404);
        const evidence = store.evidenceFor(row.id).map((e) => ({ hash: e.evidence_hash, body: e.body, receipt: e.receipt_sig, by: e.submitted_by, at: e.created_at }));
        return json({ ...view(row), evidence, verdict: store.verdict(row.id), events: store.events(row.id) });
      }
      if (p === "/sellers") return json({ sellers: await sellers() });
      if (p === "/stats") return json({ ...(store.stats() as object), keeper: keeper().account.address });
      if (p === "/activity") return json({ events: store.recentEvents(Number(url.searchParams.get("limit") ?? 30)) });
      if (p === "/judge" && req.method === "POST") return judgeRoute(req);
      if (p === "/demo/buy" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { seller?: string; document?: string };
        return demoBuy(String(b.seller ?? ""), b.document);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: (e as Error).message }, 500);
    }
  };
}
