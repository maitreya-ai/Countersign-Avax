// x402 facilitator for Avalanche: /facilitator/verify and /facilitator/settle for
//   - `exact`: EIP-3009 transferWithAuthorization (local, the node pays gas; or forwarded to PayAI)
//   - `countersign`: CountersignEscrow.openWithAuthorization (the node pays gas; it can never redirect funds,
//              because the escrow terms are the buyer-signed nonce)

import { parseEventLogs, type Address, type Hex } from "viem";
import {
  escrowAbi, escrowIdFor, parseAgentId, rubricHashOf, splitSig, termsHash, usdcAbi, usdcDomain, verifyAuthorization,
  type CountersignExtra, type CountersignPayload, type ExactPayload, type PaymentRequirements, type SettleResponse, type VerifyResponse,
} from "@countersign/x402";
import { publicClient } from "@countersign/core";
import { cfg, reason, send } from "./ctx";
import { store } from "./store";

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

async function commonChecks(from: Address, nonce: Hex, value: bigint, validAfter: bigint, validBefore: bigint): Promise<string | null> {
  const n = nowSec();
  if (validAfter > n) return "authorization_not_yet_valid";
  if (validBefore <= n + 6n) return "authorization_expired";
  const [used, bal] = await Promise.all([
    publicClient.readContract({ address: cfg.usdc, abi: usdcAbi, functionName: "authorizationState", args: [from, nonce] }),
    publicClient.readContract({ address: cfg.usdc, abi: usdcAbi, functionName: "balanceOf", args: [from] }),
  ]);
  if (used) return "nonce_used";
  if (bal < value) return "insufficient_funds";
  return null;
}

// ---- exact ----------------------------------------------------------------------

async function verifyExact(p: ExactPayload, req: PaymentRequirements): Promise<VerifyResponse> {
  const a = p?.payload?.authorization;
  if (!a || !p.payload.signature) return { isValid: false, invalidReason: "invalid_payload" };
  if (req.network !== cfg.network || req.asset.toLowerCase() !== cfg.usdc.toLowerCase()) return { isValid: false, invalidReason: "invalid_network" };
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { isValid: false, invalidReason: "invalid_payee" };
  if (BigInt(a.value) < BigInt(req.amount)) return { isValid: false, invalidReason: "insufficient_amount" };
  const domain = usdcDomain(cfg.chainId, cfg.usdc, req.extra?.name, req.extra?.version);
  if (!(await verifyAuthorization("transfer", domain, a, p.payload.signature))) return { isValid: false, invalidReason: "invalid_signature" };
  const err = await commonChecks(a.from, a.nonce, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore));
  return err ? { isValid: false, invalidReason: err } : { isValid: true, payer: a.from };
}

async function settleExact(p: ExactPayload, req: PaymentRequirements): Promise<SettleResponse> {
  const v = await verifyExact(p, req);
  if (!v.isValid) return { success: false, network: cfg.network, errorReason: v.invalidReason };
  const a = p.payload.authorization;
  const { v: sv, r, s } = splitSig(p.payload.signature);
  try {
    const { hash } = await send({
      address: cfg.usdc, abi: usdcAbi as any, functionName: "transferWithAuthorization",
      args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, sv, r, s],
    });
    return { success: true, transaction: hash, network: cfg.network, payer: a.from };
  } catch (e) {
    return { success: false, network: cfg.network, errorReason: `settle_failed: ${reason(e)}` };
  }
}

async function payai(path: "verify" | "settle", body: unknown) {
  const res = await fetch(`${cfg.payaiUrl}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json()) as any;
}

// ---- countersign ------------------------------------------------------------------------

function countersignTerms(p: CountersignPayload, req: PaymentRequirements<CountersignExtra>) {
  const a = p.payload.authorization;
  const x = req.extra;
  const nonce = termsHash({
    chainId: cfg.chainId, escrow: cfg.escrow, payee: req.payTo, arbiter: x.arbiter, amount: BigInt(a.value),
    deadline: BigInt(p.payload.deadline), rubricHash: rubricHashOf(x.rubric), policy: x.policy,
    agentId: parseAgentId(x.agentId), salt: p.payload.salt,
  });
  return { nonce, escrowId: escrowIdFor(a.from, nonce) };
}

async function verifyCountersign(p: CountersignPayload, req: PaymentRequirements<CountersignExtra>): Promise<VerifyResponse> {
  const a = p?.payload?.authorization;
  if (!a || !p.payload.signature || !p.payload.salt || !p.payload.deadline) return { isValid: false, invalidReason: "invalid_payload" };
  if (req.network !== cfg.network || req.asset.toLowerCase() !== cfg.usdc.toLowerCase()) return { isValid: false, invalidReason: "invalid_network" };
  if (req.extra.escrow.toLowerCase() !== cfg.escrow.toLowerCase() || a.to.toLowerCase() !== cfg.escrow.toLowerCase()) {
    return { isValid: false, invalidReason: "unknown_escrow" };
  }
  if (BigInt(a.value) < BigInt(req.amount)) return { isValid: false, invalidReason: "insufficient_amount" };
  if (BigInt(p.payload.deadline) <= nowSec()) return { isValid: false, invalidReason: "deadline_passed" };
  const { nonce } = countersignTerms(p, req);
  if (nonce.toLowerCase() !== a.nonce.toLowerCase()) return { isValid: false, invalidReason: "terms_mismatch" };
  const domain = usdcDomain(cfg.chainId, cfg.usdc, req.extra.name, req.extra.version);
  if (!(await verifyAuthorization("receive", domain, a, p.payload.signature))) return { isValid: false, invalidReason: "invalid_signature" };
  const err = await commonChecks(a.from, a.nonce, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore));
  return err ? { isValid: false, invalidReason: err } : { isValid: true, payer: a.from };
}

async function settleCountersign(p: CountersignPayload, req: PaymentRequirements<CountersignExtra>): Promise<SettleResponse> {
  const v = await verifyCountersign(p, req);
  if (!v.isValid) return { success: false, network: cfg.network, errorReason: v.invalidReason };
  const a = p.payload.authorization;
  const x = req.extra;
  const { escrowId } = countersignTerms(p, req);
  const { v: sv, r, s } = splitSig(p.payload.signature);
  try {
    const { hash, receipt } = await send({
      address: cfg.escrow, abi: escrowAbi as any, functionName: "openWithAuthorization",
      args: [
        {
          payer: a.from, payee: req.payTo, arbiter: x.arbiter, amount: BigInt(a.value), deadline: BigInt(p.payload.deadline),
          agentId: parseAgentId(x.agentId), salt: p.payload.salt, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore),
          v: sv, r, s,
        },
        x.rubric,
        x.policy,
      ],
    });
    const logs = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "Opened" });
    const id = (logs[0]?.args.id ?? escrowId) as Hex;
    // remember which resource this escrow paid for (the chain only knows payer/payee)
    store.ensure(id);
    store.update(id, { resource: req.resource, seller: req.resource.split("/").slice(-2, -1)[0] ?? null });
    store.event(id, "opened", hash, `${a.value} atomic USDC, gasless for the buyer`);
    return { success: true, transaction: hash, network: cfg.network, payer: a.from, escrowId: id };
  } catch (e) {
    return { success: false, network: cfg.network, errorReason: `open_failed: ${reason(e)}` };
  }
}

// ---- dispatch -----------------------------------------------------------------------

export async function facilitatorVerify(body: any): Promise<VerifyResponse> {
  const { paymentPayload: p, paymentRequirements: req } = body ?? {};
  if (!p || !req) return { isValid: false, invalidReason: "invalid_request" };
  if (req.scheme === "countersign") return verifyCountersign(p, req);
  if (req.scheme === "exact") return cfg.exactFacilitator === "payai" ? payai("verify", body) : verifyExact(p, req);
  return { isValid: false, invalidReason: "unsupported_scheme" };
}

export async function facilitatorSettle(body: any): Promise<SettleResponse> {
  const { paymentPayload: p, paymentRequirements: req } = body ?? {};
  if (!p || !req) return { success: false, network: cfg.network, errorReason: "invalid_request" };
  if (req.scheme === "countersign") return settleCountersign(p, req);
  if (req.scheme === "exact") return cfg.exactFacilitator === "payai" ? payai("settle", body) : settleExact(p, req);
  return { success: false, network: cfg.network, errorReason: "unsupported_scheme" };
}

export function supported() {
  return {
    kinds: [
      { x402Version: 2, scheme: "exact", network: cfg.network },
      { x402Version: 2, scheme: "countersign", network: cfg.network, extra: { escrow: cfg.escrow } },
    ],
  };
}
