// Buyer side of the x402 `countersign` scheme.
//
//   const p = await fetchWithCountersign(url, { method: "POST", body }, { account, publicClient, maxAmount: 1_000_000n });
//   const final = await p.watch();   // Resolved (seller paid) | Refunded (judged NO, equivocation, deadline)
//
// 1. Unpaid request -> 402 offer. Pick `countersign` (or `exact`).
// 2. Optional trust check: the seller's ERC-8004 validation summary from CountersignValidator.
// 3. Compute the terms hash locally and sign ONE gasless ReceiveWithAuthorization (to = escrow).
// 4. On 200: rebuild the evidence from the exact bytes sent and received, check the seller's receipt,
//    and send it to the node as a backup (so a seller cannot withhold or swap evidence).
// 5. watch(): poll the escrow; if the committed evidence differs from our receipt, report equivocation.

import type { Account, Address, Hex, LocalAccount, PublicClient, WalletClient } from "viem";
import { escrowAbi, identityRegistryAbi, validationRegistryAbi, validatorAbi } from "./abi";
import { signReceiveAuthorization, signTransferAuthorization, usdcDomain, verifyReceipt } from "./eip712";
import { HEADERS, decodeHeader, encodeHeader } from "./encoding";
import { buildEvidence } from "./evidence";
import { postEvidence } from "./server";
import { NO_AGENT, escrowIdFor, parseAgentId, randomSalt, rubricHashOf, termsHash } from "./terms";
import {
  REASON_NAMES, SCHEME, STATE_NAMES, VALIDATION_TAG_STRING, type CountersignExtra, type CountersignReceipt, type Authorization,
  type EscrowView, type PaymentRequired, type PaymentRequirements, type SettleResponse,
} from "./types";

export type Buyer = LocalAccount | { wallet: WalletClient; account: Account | Address };

export function buyerAddress(b: Buyer): Address {
  if ("wallet" in b) return typeof b.account === "string" ? b.account : b.account.address;
  return b.address;
}

export interface Offer {
  status: number;
  required?: PaymentRequired;
  countersign?: PaymentRequirements<CountersignExtra>;
  exact?: PaymentRequirements;
}

export interface SellerTrust {
  agentId: bigint | null;
  count: number;          // judged sales on record
  avg: number;            // 0..100 average score
  ownerMatchesPayTo: boolean;
  selfFiling: boolean;    // seller let the validator file records itself (cannot hide failures)
}

export interface FinalEscrow {
  state: (typeof STATE_NAMES)[number];
  reason: (typeof REASON_NAMES)[number];
  escrow: EscrowView;
  equivocationReported: boolean;
}

export interface Purchase {
  response: Response;
  body: Uint8Array;
  scheme: string;
  payment?: SettleResponse;
  escrowId?: Hex;
  receipt?: CountersignReceipt;
  receiptValid?: boolean;
  evidence?: string;
  trust?: SellerTrust;
  watch(opts?: { intervalMs?: number; timeoutMs?: number; onTick?: (e: EscrowView) => void }): Promise<FinalEscrow>;
}

export interface FetchWithCountersignOptions {
  account: Buyer;
  publicClient: PublicClient;
  prefer?: "countersign" | "exact";
  maxAmount: bigint;
  minTrust?: { minCount: number; minAvg: number; requireSelfFiling?: boolean };
  /** Send our copy of the evidence + receipt to the node (default true). */
  backupEvidence?: boolean;
  log?: (msg: string) => void;
}

function bodyBytes(init: RequestInit): Uint8Array {
  if (init.body === undefined || init.body === null) return new Uint8Array();
  if (typeof init.body === "string") return new TextEncoder().encode(init.body);
  if (init.body instanceof Uint8Array) return init.body;
  throw new Error("fetchWithCountersign needs a string or Uint8Array body (exact bytes are part of the evidence)");
}

/** Make the unpaid request and return the seller's offer. */
export async function getOffer(url: string, init: RequestInit = {}): Promise<Offer> {
  const res = await fetch(url, init);
  if (res.status !== 402) return { status: res.status };
  const h = res.headers.get(HEADERS.required);
  const required: PaymentRequired = h ? decodeHeader(h) : await res.json();
  return {
    status: 402,
    required,
    countersign: required.accepts.find((a) => a.scheme === SCHEME) as PaymentRequirements<CountersignExtra> | undefined,
    exact: required.accepts.find((a) => a.scheme === "exact"),
  };
}

/** Read the seller's verified track record before buying. */
export async function sellerTrust(client: PublicClient, req: PaymentRequirements<CountersignExtra>): Promise<SellerTrust> {
  const { extra } = req;
  const agentId = parseAgentId(extra.agentId);
  if (agentId === NO_AGENT || !extra.validator || !extra.validationRegistry || !extra.identityRegistry) {
    return { agentId: null, count: 0, avg: 0, ownerMatchesPayTo: false, selfFiling: false };
  }
  const [summary, owner, selfFiling] = await Promise.all([
    client.readContract({ address: extra.validationRegistry, abi: validationRegistryAbi, functionName: "getSummary", args: [agentId, [extra.validator], VALIDATION_TAG_STRING] }),
    client.readContract({ address: extra.identityRegistry, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }).catch(() => "0x" as Address),
    client.readContract({ address: extra.validator, abi: validatorAbi, functionName: "canSelfFile", args: [agentId] }).catch(() => false),
  ]);
  return {
    agentId,
    count: Number(summary[0]),
    avg: Number(summary[1]),
    ownerMatchesPayTo: owner.toLowerCase() === req.payTo.toLowerCase(),
    selfFiling,
  };
}

export async function readEscrow(client: PublicClient, escrow: Address, id: Hex): Promise<EscrowView> {
  return (await client.readContract({ address: escrow, abi: escrowAbi, functionName: "get", args: [id] })) as unknown as EscrowView;
}

export async function fetchWithCountersign(url: string, init: RequestInit, opts: FetchWithCountersignOptions): Promise<Purchase> {
  const log = opts.log ?? (() => {});
  const sent = bodyBytes(init);
  const method = (init.method ?? "GET").toUpperCase();
  const offer = await getOffer(url, { ...init, body: sent as BodyInit });
  if (offer.status !== 402) throw new Error(`expected 402, got ${offer.status}`);
  const prefer = opts.prefer ?? "countersign";
  const chosen = prefer === "countersign" ? offer.countersign ?? offer.exact : offer.exact ?? offer.countersign;
  if (!chosen) throw new Error("seller offers no supported scheme");
  if (BigInt(chosen.amount) > opts.maxAmount) throw new Error(`price ${chosen.amount} above maxAmount ${opts.maxAmount}`);
  const chainId = Number(chosen.network.split(":")[1]);
  const from = buyerAddress(opts.account);
  const now = Math.floor(Date.now() / 1000);
  const domain = usdcDomain(chainId, chosen.asset, (chosen.extra as any).name, (chosen.extra as any).version);

  // ---- exact: final payment --------------------------------------------------------
  if (chosen.scheme === "exact") {
    const authorization: Authorization = {
      from, to: chosen.payTo, value: chosen.amount, validAfter: String(now - 60), validBefore: String(now + chosen.maxTimeoutSeconds),
      nonce: randomSalt(),
    };
    const signature = await signTransferAuthorization(opts.account, domain, authorization);
    const res = await fetch(url, { ...init, body: sent as BodyInit, headers: { ...(init.headers as any), [HEADERS.signature]: encodeHeader({ x402Version: 2, accepted: chosen, payload: { signature, authorization } }) } });
    const body = new Uint8Array(await res.arrayBuffer());
    const pr = res.headers.get(HEADERS.response);
    return {
      response: new Response(body as BodyInit, { status: res.status, headers: res.headers }), body, scheme: "exact",
      payment: pr ? decodeHeader(pr) : undefined,
      watch: async () => { throw new Error("exact payments are final; nothing to watch"); },
    };
  }

  // ---- countersign: judged escrow ----------------------------------------------------------
  const req = chosen as PaymentRequirements<CountersignExtra>;
  const x = req.extra;
  let trust: SellerTrust | undefined;
  if (opts.minTrust) {
    trust = await sellerTrust(opts.publicClient, req);
    log(`trust: agent ${trust.agentId ?? "-"} records=${trust.count} avg=${trust.avg} owner=payTo:${trust.ownerMatchesPayTo} selfFiling:${trust.selfFiling}`);
    if (trust.agentId !== null && !trust.ownerMatchesPayTo) throw new Error("seller advertises an agent id it does not own");
    if (opts.minTrust.requireSelfFiling && !trust.selfFiling) throw new Error("seller can hide failed sales (validator not approved)");
    if (trust.count >= opts.minTrust.minCount && trust.avg < opts.minTrust.minAvg) {
      throw new Error(`seller's verified record ${trust.avg}/100 over ${trust.count} sales is below ${opts.minTrust.minAvg}`);
    }
  }
  if (sent.length > x.evidence.maxRequestBytes) throw new Error("request body above the seller's evidence limit");

  const salt = randomSalt();
  const deadline = BigInt(now + x.deadlineSeconds);
  const agentId = parseAgentId(x.agentId);
  const nonce = termsHash({
    chainId, escrow: x.escrow, payee: req.payTo, arbiter: x.arbiter, amount: BigInt(req.amount), deadline,
    rubricHash: rubricHashOf(x.rubric), policy: x.policy, agentId, salt,
  });
  const authorization: Authorization = {
    from, to: x.escrow, value: req.amount, validAfter: String(now - 60), validBefore: String(now + req.maxTimeoutSeconds), nonce,
  };
  const signature = await signReceiveAuthorization(opts.account, domain, authorization);
  const escrowId = escrowIdFor(from, nonce);
  log(`signed ReceiveWithAuthorization (gasless), escrow id ${escrowId}`);

  const payload = { x402Version: 2, accepted: req, payload: { signature, authorization, salt, deadline: deadline.toString() } };
  const res = await fetch(url, { ...init, body: sent as BodyInit, headers: { ...(init.headers as any), [HEADERS.signature]: encodeHeader(payload) } });
  const body = new Uint8Array(await res.arrayBuffer());
  const pr = res.headers.get(HEADERS.response);
  const payment: SettleResponse | undefined = pr ? decodeHeader(pr) : undefined;
  const rh = res.headers.get(HEADERS.receipt);
  const receipt: CountersignReceipt | undefined = rh ? decodeHeader(rh) : undefined;

  let receiptValid = false;
  let evidence: string | undefined;
  if (receipt) {
    const path = new URL(url).pathname;
    const ev = buildEvidence({ method, path, requestBody: sent, status: res.status, responseBody: body });
    evidence = ev.text;
    receiptValid = ev.hash.toLowerCase() === receipt.evidenceHash.toLowerCase()
      && receipt.escrowId.toLowerCase() === escrowId.toLowerCase()
      && (await verifyReceipt(req.payTo, chainId, x.escrow, escrowId, receipt.evidenceHash, receipt.signature, opts.publicClient));
    log(`receipt ${receiptValid ? "matches the bytes we received" : "DOES NOT match what we received"}`);
    if (receiptValid && x.facilitator && opts.backupEvidence !== false) {
      void postEvidence(x.facilitator, { escrowId, evidence: ev.text, receipt: { evidenceHash: receipt.evidenceHash, signature: receipt.signature }, by: "buyer" });
    }
  } else if (res.status === 402) {
    throw new Error(`payment rejected: ${new TextDecoder().decode(body).slice(0, 300)}`);
  }

  const watch: Purchase["watch"] = async (w = {}) => {
    const interval = w.intervalMs ?? 2000;
    const stopAt = Date.now() + (w.timeoutMs ?? (x.deadlineSeconds + 180) * 1000);
    let reported = false;
    for (;;) {
      const e = await readEscrow(opts.publicClient, x.escrow, escrowId);
      w.onTick?.(e);
      const committed = e.evidenceHash;
      if (!reported && receipt && receiptValid && committed !== `0x${"0".repeat(64)}` && committed.toLowerCase() !== receipt.evidenceHash.toLowerCase()) {
        // seller committed something other than what it served: our receipt proves it
        log(`equivocation: committed ${committed} but served ${receipt.evidenceHash}; reporting`);
        if (x.facilitator && evidence) {
          await postEvidence(x.facilitator, { escrowId, evidence, receipt: { evidenceHash: receipt.evidenceHash, signature: receipt.signature }, by: "buyer" });
        }
        reported = true;
      }
      if (e.state === 2 || e.state === 3 || Date.now() > stopAt) {
        return { state: STATE_NAMES[e.state]!, reason: REASON_NAMES[e.reason]!, escrow: e, equivocationReported: reported };
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  };

  return {
    response: new Response(body as BodyInit, { status: res.status, headers: res.headers }),
    body, scheme: SCHEME, payment, escrowId, receipt, receiptValid, evidence, trust, watch,
  };
}
