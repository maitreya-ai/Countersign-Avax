"use client";

// In-browser verification of one purchase from public chain data. Trusts neither the Countersign
// node nor this website: every check re-derives a value from transaction calldata or contract state.
// Seller receipts are checked too when the node can supply them (they are off-chain by design).

import { keccak256, toBytes, type Hex } from "viem";
import { escrowAbi, registryAbi, requestHashFor, validationRegistryAbi, verifyReceipt, NO_AGENT } from "@countersign/x402";
import { verifySettleTx } from "@countersign/core/src/verify";
import { callClient, decodeSettle, type ChainEscrow } from "./chain";
import { CONFIG } from "./config";
import type { NodeEscrowExtras } from "./api";

export interface CheckResult { label: string; ok: boolean; detail?: string }

export interface VerifyDeps {
  client: typeof callClient;
  decodeSettle: typeof decodeSettle;
  chainId: number;
  contracts: { escrow: Hex; signerRegistry: Hex; validator: Hex; validationRegistry: Hex };
}

const DEFAULT_DEPS: VerifyDeps = { client: callClient, decodeSettle, chainId: CONFIG.chainId, contracts: CONFIG.contracts };

export async function verifyInBrowser(e: ChainEscrow, extras: NodeEscrowExtras | null, deps: VerifyDeps = DEFAULT_DEPS): Promise<CheckResult[]> {
  const client = deps.client;
  const out: CheckResult[] = [];
  const add = (label: string, ok: boolean, detail?: string) => out.push({ label, ok, detail });
  const c = deps.contracts;

  const onchain = await client.readContract({ address: c.escrow, abi: escrowAbi, functionName: "get", args: [e.id] });
  add("Escrow exists on-chain", onchain.state !== 0, `state ${["None", "Open", "Resolved", "Refunded", "Escalated"][onchain.state]}`);
  add("Rubric text (from the Opened event) hashes to the stored rubricHash", keccak256(toBytes(e.rubric)) === onchain.rubricHash, onchain.rubricHash);

  if (e.tx.settle) {
    const v = await verifySettleTx(client as any, c.signerRegistry, e.tx.settle as Hex);
    const decoded = await deps.decodeSettle(e.tx.settle as Hex);
    add("Settle calldata targets this escrow", v.escrowId.toLowerCase() === e.id.toLowerCase());
    if (decoded.evidence !== null) {
      add("The evidence the judges saw hashes to the committed evidenceHash", keccak256(toBytes(decoded.evidence)) === onchain.evidenceHash, onchain.evidenceHash);
    }
    for (const a of v.attestations) {
      add(`${a.role}: sha256(req):sha256(resp) recovers a registered judge key`, a.registered && a.providerMatches, `${a.recovered.slice(0, 10)}… signed ${a.signedText.slice(0, 16)}…`);
      add(`${a.role}: verdict header names this rubric and evidence`, a.rubricHash === onchain.rubricHash && a.evidenceHash === onchain.evidenceHash, `VERDICT:${a.verdict} CONF:${a.conf.toFixed(2)}`);
    }
    const judges = v.attestations.filter((a) => a.role.startsWith("judge"));
    const models = await Promise.all(judges.map((j) => client.readContract({ address: c.signerRegistry, abi: registryAbi, functionName: "modelOf", args: [j.recovered] })));
    add("Judges are distinct models", new Set(models).size === models.length, `${models.length} judges`);
    const p = onchain.policy;
    const first = judges[0]?.verdict;
    const agree = judges.filter((j) => j.verdict === first).length;
    const g = v.attestations.find((a) => a.role === "grounding");
    const cal = v.attestations.find((a) => a.role === "calibration");
    let expected: "YES" | "NO" | "ESCALATE" = first === "Y" ? "YES" : first === "N" ? "NO" : "ESCALATE";
    if (agree < p.minAgree || (p.requireGrounded && g?.verdict !== "Y") || Math.round((cal?.conf ?? 0) * 10000) < p.minConfBps) expected = "ESCALATE";
    const actual = onchain.reason === 1 ? "YES" : onchain.reason === 2 ? "NO" : onchain.state === 4 ? "ESCALATE" : "other";
    add("Re-applying the quorum policy gives the on-chain outcome", expected === actual, `${p.minAgree}/${p.judges} agree, grounded, conf ≥ ${(p.minConfBps / 100).toFixed(0)}% → ${expected}`);
  }

  if (e.reason === "Equivocation") {
    add("Equivocated event: the contract itself verified the seller's second signed receipt", Boolean(e.tx.final), e.tx.final ?? undefined);
  }

  // seller receipts (off-chain): checked when the node provides them
  if (extras?.evidence.length) {
    for (const ev of extras.evidence) {
      const ok = keccak256(toBytes(ev.body)) === ev.hash
        && (await verifyReceipt(onchain.payee, deps.chainId, c.escrow, e.id, ev.hash as Hex, ev.receipt as Hex, client as any));
      add(`Seller's EIP-712 receipt for evidence ${ev.hash.slice(0, 10)}… (${ev.by} copy) recovers to the seller`, ok);
    }
  }

  if (onchain.agentId !== NO_AGENT && (onchain.reason === 1 || onchain.reason === 2 || onchain.reason === 6)) {
    try {
      const [validator, agentId, response] = await client.readContract({ address: c.validationRegistry, abi: validationRegistryAbi, functionName: "getValidationStatus", args: [requestHashFor(e.id, onchain.agentId)] });
      const want = onchain.reason === 1 ? 100 : 0;
      add(
        "ERC-8004 record: written by CountersignValidator, for the agent the buyer paid, with the right score",
        validator.toLowerCase() === c.validator.toLowerCase() && agentId === onchain.agentId && response === want,
        `agent #${agentId} · response ${response}`,
      );
    } catch {
      add("ERC-8004 record written", false, "no validation record yet");
    }
  }
  return out;
}
