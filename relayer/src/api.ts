// Verdict-as-a-service over x402: agents pay USDC on Arc per verdict. Settlement goes through
// Circle's Facilitator Service (https://developers.circle.com/facilitator-service) when
// CIRCLE_API_KEY is set, otherwise through the local EIP-3009 facilitator in x402.ts.
//
//   POST /verdict  { rubric, evidence }
//     -> 402 + PAYMENT-REQUIRED header (x402) when unpaid
//     -> 200 { bundle, requestIds, calldata } after /verify + /settle succeed
//   GET  /health
//
// Env: ARC_PRIVATE_KEY (payTo = this wallet), VERDICT_PRICE_USDC (default 0.05),
//      CIRCLE_API_KEY (optional; unset = local facilitator, the server wallet pays settle gas).
//   bun run src/api.ts

import { encodeFunctionData, keccak256, toHex } from "viem";
import { escrowAbi, USDC, wallet } from "./arc";
import { buildBundle, toAttestedArg } from "./judges";
import type { Case } from "./types";
import { settlePayment, verifyPayment, type PaymentPayload } from "./x402";

const FACILITATOR = process.env.CIRCLE_FACILITATOR ?? "https://api.circle.com/v1/facilitator/x402";
const NETWORK = `eip155:${process.env.ARC_CHAIN_ID ?? 5042002}`;
const PRICE = Math.round(Number(process.env.VERDICT_PRICE_USDC ?? "0.05") * 1e6).toString(); // atomic (6 dp)
const PORT = Number(process.env.PORT ?? 8402);
const payTo = wallet().account.address;

function requirements(resource: string) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: USDC,
    amount: PRICE,
    payTo,
    maxTimeoutSeconds: 600,
    resource,
    description: "One Verdict bundle (signed model attestations for CountersignEscrow.settle)",
    mimeType: "application/json",
    extra: { name: "USDC", version: "2" },
  };
}

function paymentRequired(resource: string): Response {
  const body = { x402Version: 2, accepts: [requirements(resource)], error: "Payment required" };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "Content-Type": "application/json", "PAYMENT-REQUIRED": btoa(JSON.stringify(body)) },
  });
}

async function facilitator(path: "verify" | "settle", paymentPayload: unknown, paymentRequirements: ReturnType<typeof requirements>) {
  const key = process.env.CIRCLE_API_KEY;
  if (!key) {
    return path === "verify"
      ? verifyPayment(paymentPayload as PaymentPayload, paymentRequirements)
      : settlePayment(paymentPayload as PaymentPayload);
  }
  const res = await fetch(`${FACILITATOR}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`facilitator ${path} ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, payTo, price: PRICE, network: NETWORK });
    if (url.pathname !== "/verdict" || req.method !== "POST") return new Response("not found", { status: 404 });

    const sigHeader = req.headers.get("PAYMENT-SIGNATURE") ?? req.headers.get("X-PAYMENT");
    if (!sigHeader) return paymentRequired(url.toString());

    let paymentPayload: unknown;
    try { paymentPayload = JSON.parse(atob(sigHeader)); } catch { return new Response("bad PAYMENT-SIGNATURE", { status: 400 }); }
    const reqs = requirements(url.toString());

    const v = await facilitator("verify", paymentPayload, reqs);
    if (v.isValid === false) return Response.json({ error: "payment invalid", detail: v }, { status: 402 });

    const body = (await req.json()) as { rubric?: string; evidence?: string };
    if (!body.rubric || !body.evidence) return new Response("rubric and evidence required", { status: 400 });

    const c: Case = { rubric: body.rubric, evidence: body.evidence, rubricHash: keccak256(toHex(body.rubric)), evidenceHash: keccak256(toHex(body.evidence)) };
    const bundle = await buildBundle(c, () => {});

    const settlement = await facilitator("settle", paymentPayload, reqs);
    if (settlement.success === false) return Response.json({ error: "payment settlement failed", detail: settlement }, { status: 402 });

    const requestIds = [...bundle.judges, bundle.grounding, bundle.calibration].map((a) => a.requestId);
    const args = [bundle.judges.map(toAttestedArg), toAttestedArg(bundle.grounding), toAttestedArg(bundle.calibration)] as const;
    // calldata for CountersignEscrow.settle with a placeholder id; the caller swaps in its escrow id
    const calldata = encodeFunctionData({
      abi: escrowAbi, functionName: "settle",
      args: ["0x" + "00".repeat(32) as `0x${string}`, ...args, requestIds],
    });
    const attestations = args.flat().map((a) => ({ ...a }));
    return Response.json({ attestations, requestIds, settleCalldata: calldata, payment: settlement }, {
      headers: { "PAYMENT-RESPONSE": btoa(JSON.stringify(settlement)) },
    });
  },
});

console.log(`verdict api on :${PORT}  payTo ${payTo}  price ${PRICE} (atomic USDC) on ${NETWORK}  facilitator ${process.env.CIRCLE_API_KEY ? FACILITATOR : "local (EIP-3009)"}`);
