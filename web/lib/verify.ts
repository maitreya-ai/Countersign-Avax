"use client";

// In-browser verification of one purchase, from public chain data only. Trusts neither the Countersign
// node nor this website: every check re-derives a value from transaction calldata or contract state.

import { createPublicClient, http, keccak256, toBytes, type Hex } from "viem";
import { escrowAbi, registryAbi, requestHashFor, validationRegistryAbi, verifyReceipt, NO_AGENT } from "@countersign/x402";
import { verifySettleTx } from "@countersign/core/src/verify";
import type { EscrowDetail, NodeConfig } from "./api";

export interface CheckResult { label: string; ok: boolean; detail?: string }

export async function verifyInBrowser(cfg: NodeConfig, e: EscrowDetail): Promise<CheckResult[]> {
  const client = createPublicClient({ transport: http(cfg.rpc) });
  const out: CheckResult[] = [];
  const add = (label: string, ok: boolean, detail?: string) => out.push({ label, ok, detail });

  const onchain = await client.readContract({ address: cfg.contracts.escrow, abi: escrowAbi, functionName: "get", args: [e.id] });
  add("Escrow exists on-chain", onchain.state !== 0, `state ${["None", "Open", "Resolved", "Refunded", "Escalated"][onchain.state]}`);

  const rubricOk = keccak256(toBytes(e.rubric ?? "")) === onchain.rubricHash;
  add("Rubric text hashes to the on-chain rubricHash", rubricOk, onchain.rubricHash);

  const committed = e.evidence.find((x) => x.hash.toLowerCase() === onchain.evidenceHash.toLowerCase());
  if (committed) {
    add("Evidence bytes hash to the on-chain evidenceHash", keccak256(toBytes(committed.body)) === onchain.evidenceHash, onchain.evidenceHash);
    const sigOk = await verifyReceipt(onchain.payee, cfg.chainId, cfg.contracts.escrow, e.id, onchain.evidenceHash, committed.receipt as Hex, client as any);
    add("Seller's EIP-712 receipt for that evidence recovers to the payee", sigOk, onchain.payee);
  } else if (onchain.evidenceHash !== `0x${"0".repeat(64)}`) {
    add("Committed evidence bytes available", false, "the node has no copy of the committed bytes");
  }

  const others = e.evidence.filter((x) => x.hash.toLowerCase() !== onchain.evidenceHash.toLowerCase());
  for (const o of others) {
    const sigOk = await verifyReceipt(onchain.payee, cfg.chainId, cfg.contracts.escrow, e.id, o.hash as Hex, o.receipt as Hex, client as any);
    add("A second, different receipt is also signed by the payee (equivocation)", sigOk, `${o.hash.slice(0, 18)}… from ${o.by}`);
  }

  if (e.tx.settle) {
    const v = await verifySettleTx(client as any, cfg.contracts.signerRegistry, e.tx.settle as Hex);
    add("Settle calldata targets this escrow", v.escrowId.toLowerCase() === e.id.toLowerCase());
    for (const a of v.attestations) {
      add(
        `${a.role}: sha256(req):sha256(resp) recovers a registered judge key`,
        a.registered && a.providerMatches,
        `${a.recovered.slice(0, 10)}… signed ${a.signedText.slice(0, 16)}…`,
      );
      add(`${a.role}: verdict header names this rubric and evidence`, a.rubricHash === onchain.rubricHash && a.evidenceHash === onchain.evidenceHash, `VERDICT:${a.verdict} CONF:${a.conf.toFixed(2)}`);
    }
    const judges = v.attestations.filter((a) => a.role.startsWith("judge"));
    const models = await Promise.all(judges.map((j) => client.readContract({ address: cfg.contracts.signerRegistry, abi: registryAbi, functionName: "modelOf", args: [j.recovered] })));
    add("Judges are distinct models", new Set(models).size === models.length, `${models.length} judges`);
    const p = onchain.policy;
    const first = judges[0]?.verdict;
    const agree = judges.filter((j) => j.verdict === first).length;
    const g = v.attestations.find((a) => a.role === "grounding");
    const c = v.attestations.find((a) => a.role === "calibration");
    let expected: "YES" | "NO" | "ESCALATE" = first === "Y" ? "YES" : first === "N" ? "NO" : "ESCALATE";
    if (agree < p.minAgree || (p.requireGrounded && g?.verdict !== "Y") || Math.round((c?.conf ?? 0) * 10000) < p.minConfBps) expected = "ESCALATE";
    const actual = onchain.reason === 1 ? "YES" : onchain.reason === 2 ? "NO" : onchain.state === 4 ? "ESCALATE" : "other";
    add("Re-applying the quorum policy gives the on-chain outcome", expected === actual, `policy ${p.minAgree}/${p.judges} agree, grounded, conf ≥ ${(p.minConfBps / 100).toFixed(0)}% → ${expected}`);
  }

  if (onchain.agentId !== NO_AGENT && cfg.contracts.validationRegistry && cfg.contracts.validator && (onchain.reason === 1 || onchain.reason === 2 || onchain.reason === 6)) {
    const rh = requestHashFor(e.id, onchain.agentId);
    try {
      const [validator, agentId, response] = await client.readContract({ address: cfg.contracts.validationRegistry, abi: validationRegistryAbi, functionName: "getValidationStatus", args: [rh] });
      const want = onchain.reason === 1 ? 100 : 0;
      add(
        "ERC-8004 record: written by CountersignValidator, for the agent the buyer paid, with the right score",
        validator.toLowerCase() === cfg.contracts.validator.toLowerCase() && agentId === onchain.agentId && response === want,
        `agent #${agentId} · response ${response}`,
      );
    } catch {
      add("ERC-8004 record written", false, "no validation record yet");
    }
  }
  return out;
}
