// Seller side of the x402 `countersign` scheme. Wrap any handler:
//
//   const route = countersignRoute({ ...cfg, handler: async ({ body }) => Response.json(await work(body)) });
//   Bun.serve({ fetch: (req) => route(req) });
//
// Unpaid request  -> 402, PAYMENT-REQUIRED offers `exact` (final) and `countersign` (judged).
// `countersign` payment -> the server re-derives the terms from ITS OWN config, checks the buyer's
//                    EIP-3009 signature, asks the facilitator to open the escrow, runs the handler,
//                    signs a receipt over the exact evidence bytes and returns it in X-COUNTERSIGN-RECEIPT,
//                    then commits the evidence through the facilitator in the background.
// The facilitator never holds funds: the escrow terms are the signed nonce.

import type { Address, Hex, LocalAccount } from "viem";
import { usdcDomain, signReceipt, verifyAuthorization } from "./eip712";
import { CORS_HEADERS, HEADERS, decodeHeader, encodeHeader } from "./encoding";
import { buildEvidence, evidenceHashOf, truncateUtf8 } from "./evidence";
import { NO_AGENT, ZERO_ADDRESS, escrowIdFor, rubricHashOf, termsHash } from "./terms";
import {
  EVIDENCE_FORMAT, SCHEME, type CountersignExtra, type CountersignPayload, type CountersignReceipt, type ExactPayload,
  type PaymentPayload, type PaymentRequired, type PaymentRequirements, type Policy, type SettleResponse, type VerifyResponse,
} from "./types";

export interface HandlerContext {
  request: Request;
  body: Uint8Array;
  scheme: "countersign" | "exact";
  payer: Address;
  escrowId?: Hex;
}

export interface CountersignRouteConfig {
  chainId: number;
  usdc: Address;
  usdcName?: string;
  usdcVersion?: string;
  escrow: Address;
  /** Seller key: payTo, and signer of evidence receipts. Needs no gas when a facilitator is used. */
  seller: LocalAccount;
  price: bigint;
  rubric: string;
  policy: Policy;
  deadlineSeconds?: number;
  arbiter?: Address;
  agentId?: bigint | null;
  validator?: Address;
  identityRegistry?: Address;
  validationRegistry?: Address;
  /** Countersign node base URL (facilitator endpoints, evidence intake). */
  facilitator: string;
  description?: string;
  mimeType?: string;
  /** Also accept the standard final `exact` payment (default true). */
  offerExact?: boolean;
  exactPrice?: bigint;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxTimeoutSeconds?: number;
  handler: (ctx: HandlerContext) => Promise<Response>;
  /** DEMO ONLY: commit different evidence than what was served, to show the equivocation proof. */
  tamperCommittedEvidence?: (servedEvidence: string) => string;
  log?: (msg: string) => void;
}

const DEFAULTS = { deadlineSeconds: 900, maxRequestBytes: 3000, maxResponseBytes: 2000, maxTimeoutSeconds: 120 };

export function countersignRequirements(cfg: CountersignRouteConfig, resource: string): PaymentRequirements<CountersignExtra> {
  return {
    scheme: SCHEME,
    network: `eip155:${cfg.chainId}`,
    asset: cfg.usdc,
    amount: cfg.price.toString(),
    payTo: cfg.seller.address,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds ?? DEFAULTS.maxTimeoutSeconds,
    resource,
    description: cfg.description ?? "Judged before payment: refunded unless verified LLM judges confirm the rubric",
    mimeType: cfg.mimeType ?? "application/json",
    extra: {
      name: cfg.usdcName ?? "USD Coin",
      version: cfg.usdcVersion ?? "2",
      escrow: cfg.escrow,
      rubric: cfg.rubric,
      policy: cfg.policy,
      deadlineSeconds: cfg.deadlineSeconds ?? DEFAULTS.deadlineSeconds,
      arbiter: cfg.arbiter ?? ZERO_ADDRESS,
      agentId: cfg.agentId === null || cfg.agentId === undefined ? null : cfg.agentId.toString(),
      validator: cfg.validator,
      identityRegistry: cfg.identityRegistry,
      validationRegistry: cfg.validationRegistry,
      facilitator: cfg.facilitator,
      evidence: {
        format: EVIDENCE_FORMAT,
        maxRequestBytes: cfg.maxRequestBytes ?? DEFAULTS.maxRequestBytes,
        maxResponseBytes: cfg.maxResponseBytes ?? DEFAULTS.maxResponseBytes,
      },
    },
  };
}

export function exactRequirements(cfg: CountersignRouteConfig, resource: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: `eip155:${cfg.chainId}`,
    asset: cfg.usdc,
    amount: (cfg.exactPrice ?? cfg.price).toString(),
    payTo: cfg.seller.address,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds ?? DEFAULTS.maxTimeoutSeconds,
    resource,
    description: "Final payment, no recourse",
    mimeType: cfg.mimeType ?? "application/json",
    extra: { name: cfg.usdcName ?? "USD Coin", version: cfg.usdcVersion ?? "2" },
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...headers } });
}

function paymentRequired(accepts: PaymentRequirements[], error = "Payment required"): Response {
  const body: PaymentRequired = { x402Version: 2, accepts, error };
  return json(body, 402, { [HEADERS.required]: encodeHeader(body) });
}

async function facilitatorCall<T>(base: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as T;
  return j;
}

/** Post evidence to the node with retries; it commits it on-chain with the receipt. */
export async function postEvidence(
  base: string,
  body: { escrowId: Hex; evidence: string; receipt: { evidenceHash: Hex; signature: Hex }; by: string },
  attempts = 5,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 409) return false;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return false;
}

export function countersignRoute(cfg: CountersignRouteConfig): (req: Request) => Promise<Response> {
  const log = cfg.log ?? (() => {});
  const domain = usdcDomain(cfg.chainId, cfg.usdc, cfg.usdcName, cfg.usdcVersion);
  const maxReq = cfg.maxRequestBytes ?? DEFAULTS.maxRequestBytes;
  const maxResp = cfg.maxResponseBytes ?? DEFAULTS.maxResponseBytes;
  const deadlineSeconds = cfg.deadlineSeconds ?? DEFAULTS.deadlineSeconds;
  const agentId = cfg.agentId === null || cfg.agentId === undefined ? NO_AGENT : cfg.agentId;
  const rubricHash = rubricHashOf(cfg.rubric);

  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const url = new URL(req.url);
    const resource = `${url.origin}${url.pathname}`;
    const countersignReq = countersignRequirements(cfg, resource);
    const accepts = cfg.offerExact === false ? [countersignReq] : [exactRequirements(cfg, resource), countersignReq];
    const body = new Uint8Array(await req.arrayBuffer());
    const header = req.headers.get(HEADERS.signature) ?? req.headers.get("X-PAYMENT");
    if (!header) return paymentRequired(accepts);

    let payment: PaymentPayload;
    try {
      payment = decodeHeader<PaymentPayload>(header);
    } catch {
      return json({ error: "bad PAYMENT-SIGNATURE" }, 400);
    }
    const scheme = payment.accepted?.scheme;
    if (scheme === "exact" && cfg.offerExact !== false) return handleExact(payment as ExactPayload);
    if (scheme === SCHEME) return handleCountersign(payment as CountersignPayload);
    return paymentRequired(accepts, "invalid_scheme");

    async function run(ctx: HandlerContext): Promise<{ status: number; bytes: Uint8Array; headers: Headers }> {
      const res = await cfg.handler(ctx);
      const bytes = truncateUtf8(new Uint8Array(await res.arrayBuffer()), maxResp);
      return { status: res.status, bytes, headers: res.headers };
    }

    async function handleExact(p: ExactPayload): Promise<Response> {
      const reqs = accepts[0]!;
      const v = await facilitatorCall<VerifyResponse>(cfg.facilitator, "/facilitator/verify", { x402Version: 2, paymentPayload: p, paymentRequirements: reqs });
      if (!v.isValid) return paymentRequired(accepts, v.invalidReason ?? "invalid_payment");
      const out = await run({ request: req, body, scheme: "exact", payer: p.payload.authorization.from });
      const s = await facilitatorCall<SettleResponse>(cfg.facilitator, "/facilitator/settle", { x402Version: 2, paymentPayload: p, paymentRequirements: reqs });
      if (!s.success) return paymentRequired(accepts, s.errorReason ?? "settle_failed");
      log(`exact: paid ${p.payload.authorization.value} by ${p.payload.authorization.from} tx ${s.transaction}`);
      return new Response(out.bytes as BodyInit, {
        status: out.status,
        headers: { "Content-Type": out.headers.get("Content-Type") ?? "application/json", ...CORS_HEADERS, [HEADERS.response]: encodeHeader(s) },
      });
    }

    async function handleCountersign(p: CountersignPayload): Promise<Response> {
      const a = p.payload?.authorization;
      const signature = p.payload?.signature;
      if (!a || !signature || !p.payload.salt || !p.payload.deadline) return paymentRequired(accepts, "invalid_payload");
      if (body.length > maxReq) return paymentRequired(accepts, "request_too_large");
      if (a.to.toLowerCase() !== cfg.escrow.toLowerCase()) return paymentRequired(accepts, "terms_mismatch");
      if (BigInt(a.value) < cfg.price) return paymentRequired(accepts, "terms_mismatch");
      const now = BigInt(Math.floor(Date.now() / 1000));
      const deadline = BigInt(p.payload.deadline);
      const drift = deadline - (now + BigInt(deadlineSeconds));
      if (drift > 60n || drift < -60n) return paymentRequired(accepts, "terms_mismatch");

      // terms from OUR config, never from the echoed `accepted`
      const nonce = termsHash({
        chainId: cfg.chainId, escrow: cfg.escrow, payee: cfg.seller.address, arbiter: cfg.arbiter ?? ZERO_ADDRESS,
        amount: BigInt(a.value), deadline, rubricHash, policy: cfg.policy, agentId, salt: p.payload.salt,
      });
      if (nonce.toLowerCase() !== a.nonce.toLowerCase()) return paymentRequired(accepts, "terms_mismatch");
      if (!(await verifyAuthorization("receive", domain, a, signature))) return paymentRequired(accepts, "invalid_signature");

      // facilitator opens the escrow (it re-checks the nonce state and balance)
      const s = await facilitatorCall<SettleResponse>(cfg.facilitator, "/facilitator/settle", {
        x402Version: 2, paymentPayload: p, paymentRequirements: countersignReq,
      });
      if (!s.success) return paymentRequired(accepts, s.errorReason ?? "open_failed");
      const escrowId = escrowIdFor(a.from, nonce);
      if (s.escrowId && s.escrowId.toLowerCase() !== escrowId.toLowerCase()) return json({ error: "facilitator returned a different escrow id" }, 502);
      log(`countersign: escrow ${escrowId} opened by ${a.from} (${a.value} atomic) tx ${s.transaction}`);

      let out;
      try {
        out = await run({ request: req, body, scheme: "countersign", payer: a.from, escrowId });
      } catch (e) {
        // no evidence will be committed: the buyer is refunded at the deadline
        log(`countersign: handler failed for ${escrowId}: ${(e as Error).message}`);
        return json({ error: "handler failed; escrow refunds at deadline", escrowId }, 500, { [HEADERS.response]: encodeHeader({ ...s, escrowId }) });
      }

      const ev = buildEvidence({ method: req.method, path: url.pathname, requestBody: body, status: out.status, responseBody: out.bytes });
      const receipt: CountersignReceipt = {
        escrowId, evidenceHash: ev.hash, signature: await signReceipt(cfg.seller, cfg.chainId, cfg.escrow, escrowId, ev.hash), format: EVIDENCE_FORMAT,
      };

      // background: commit evidence (the node submits setEvidenceWithReceipt on-chain)
      const committed = cfg.tamperCommittedEvidence ? cfg.tamperCommittedEvidence(ev.text) : ev.text;
      const committedHash = evidenceHashOf(committed);
      const committedSig = committedHash === ev.hash ? receipt.signature : await signReceipt(cfg.seller, cfg.chainId, cfg.escrow, escrowId, committedHash);
      void postEvidence(cfg.facilitator, { escrowId, evidence: committed, receipt: { evidenceHash: committedHash, signature: committedSig }, by: "seller" })
        .then((ok) => log(`countersign: evidence for ${escrowId} ${ok ? "accepted" : "NOT accepted"} by node${committedHash !== ev.hash ? " (tampered)" : ""}`));

      return new Response(out.bytes as BodyInit, {
        status: out.status,
        headers: {
          "Content-Type": out.headers.get("Content-Type") ?? "application/json",
          "Content-Encoding": "identity",
          ...CORS_HEADERS,
          [HEADERS.response]: encodeHeader({ ...s, escrowId } satisfies SettleResponse),
          [HEADERS.receipt]: encodeHeader(receipt),
        },
      });
    }
  };
}
