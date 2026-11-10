// Keeper: watches CountersignEscrow, commits evidence that arrives with a valid seller receipt, proves
// equivocation when two different signed receipts exist, judges and settles, writes the ERC-8004
// validation record, and refunds buyers after the deadline. Every action is permissionless on-chain;
// the keeper only saves the buyer and seller the gas and the bookkeeping.

import { readFileSync } from "node:fs";
import { keccak256, parseEventLogs, toBytes, type Hex } from "viem";
import { buildBundle, publicClient, registerSignersFor, settleArgs, toAttestedArg, type Bundle } from "./judgeKit";
import { escrowAbi, oracleAbi, readEscrow, validatorAbi, verifyReceipt, NO_AGENT } from "@countersign/x402";
import { HEADER_LEN, parseHeader } from "@countersign/core";
import { cfg, reason, send } from "./ctx";
import { store, type EscrowRow } from "./store";

const ZERO = `0x${"0".repeat(64)}`;
const CHALLENGE_SECONDS = Number(process.env.CHALLENGE_SECONDS ?? 4);
const STEP = BigInt(process.env.LOG_BLOCK_RANGE ?? 100); // public Fuji RPC: max 100 blocks per eth_getLogs
const nowSec = () => Math.floor(Date.now() / 1000);
const log = (m: string) => console.log(`[keeper] ${m}`);

// ---- evidence intake ------------------------------------------------------------

export async function acceptEvidence(body: any): Promise<{ status: number; body: unknown }> {
  const { escrowId, evidence, receipt, by } = body ?? {};
  if (typeof escrowId !== "string" || typeof evidence !== "string" || !receipt?.evidenceHash || !receipt?.signature) {
    return { status: 400, body: { error: "escrowId, evidence, receipt{evidenceHash, signature} required" } };
  }
  if (evidence.length > 8000) return { status: 413, body: { error: "evidence too large" } };
  const h = keccak256(toBytes(evidence));
  if (h.toLowerCase() !== String(receipt.evidenceHash).toLowerCase()) return { status: 400, body: { error: "keccak256(evidence) != receipt.evidenceHash" } };
  const e = await readEscrow(publicClient, cfg.escrow, escrowId as Hex);
  if (e.state === 0) return { status: 404, body: { error: "unknown escrow (not opened yet?)" } };
  const ok = await verifyReceipt(e.payee, cfg.chainId, cfg.escrow, escrowId as Hex, h, receipt.signature, publicClient);
  if (!ok) return { status: 400, body: { error: "receipt is not signed by the escrow payee" } };
  const fresh = store.addEvidence({ escrow_id: escrowId, evidence_hash: h, body: evidence, receipt_sig: receipt.signature, submitted_by: String(by ?? "unknown") });
  const all = store.evidenceFor(escrowId);
  if (fresh) store.event(escrowId, "evidence_received", null, `from ${by ?? "unknown"}, hash ${h.slice(0, 10)}…`);
  kick();
  return { status: 202, body: { stored: true, conflict: new Set(all.map((x) => x.evidence_hash)).size > 1 } };
}

// ---- log watcher --------------------------------------------------------------------

async function syncFromChain(id: Hex) {
  const e = await readEscrow(publicClient, cfg.escrow, id);
  store.update(id, {
    state: e.state, reason: e.reason, evidence_hash: e.evidenceHash === ZERO ? null : e.evidenceHash,
    agent_id: e.agentId === NO_AGENT ? null : e.agentId.toString(),
  });
  return e;
}

let scanning = false;
export async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const head = await publicClient.getBlockNumber();
    let from = store.getCursor("escrow");
    if (from === null) from = Number(process.env.START_BLOCK ?? deployBlock() ?? head - 200n) - 1;
    let start = BigInt(from) + 1n;
    while (start <= head) {
      const end = start + STEP - 1n > head ? head : start + STEP - 1n;
      const addresses = [cfg.escrow, ...(cfg.validator ? [cfg.validator] : [])];
      const raw = await publicClient.getLogs({ address: addresses, fromBlock: start, toBlock: end });
      const logs = parseEventLogs({ abi: [...escrowAbi, ...validatorAbi], logs: raw });
      const touched = new Set<Hex>();
      for (const l of logs) {
        const a: any = l.args;
        const id = a.id ?? a.escrowId;
        if (!id) continue;
        touched.add(id);
        switch (l.eventName) {
          case "Opened":
            store.upsertOpened({
              id, payer: a.payer, payee: a.payee, amount: a.amount.toString(), deadline: Number(a.deadline),
              rubric: a.rubric, rubricHash: a.rubricHash, tx: l.transactionHash, block: Number(l.blockNumber),
            });
            store.event(id, "opened", l.transactionHash);
            break;
          case "OpenedWithAuthorization":
            store.update(id, { agent_id: a.agentId === NO_AGENT ? null : a.agentId.toString() });
            break;
          case "EvidenceSet":
            store.update(id, { evidence_hash: a.evidenceHash, evidence_tx: l.transactionHash });
            store.event(id, "evidence_committed", l.transactionHash, a.evidenceHash);
            break;
          case "Settled":
            store.update(id, { outcome: Number(a.outcome), settle_tx: l.transactionHash });
            store.event(id, "settled", l.transactionHash, ["NO", "YES", "ESCALATE"][Number(a.outcome)]);
            break;
          case "Equivocated":
            store.update(id, { final_tx: l.transactionHash });
            store.event(id, "equivocation_proven", l.transactionHash, `committed ${a.storedEvidenceHash.slice(0, 10)}… served ${a.otherEvidenceHash.slice(0, 10)}…`);
            break;
          case "Arbitrated":
            store.update(id, { final_tx: l.transactionHash });
            store.event(id, "arbitrated", l.transactionHash, a.released ? "release" : "refund");
            break;
          case "RefundedAfterDeadline":
            store.update(id, { final_tx: l.transactionHash });
            store.event(id, "deadline_refund", l.transactionHash);
            break;
          case "Recorded":
            store.update(id, { record_tx: l.transactionHash, score: Number(a.score), record_error: null });
            store.event(id, "erc8004_recorded", l.transactionHash, `agent ${a.agentId} scored ${a.score}`);
            break;
        }
      }
      for (const id of touched) await syncFromChain(id).catch(() => {});
      store.setCursor("escrow", Number(end));
      start = end + 1n;
    }
  } catch (e) {
    log(`scan error: ${reason(e)}`);
  } finally {
    scanning = false;
  }
}

// ---- fast actions -------------------------------------------------------------------

async function commitEvidence(row: EscrowRow) {
  const ev = store.evidenceFor(row.id)[0];
  if (!ev) return;
  try {
    const { hash } = await send({
      address: cfg.escrow, abi: escrowAbi as any, functionName: "setEvidenceWithReceipt",
      args: [row.id, ev.evidence_hash, `${cfg.publicUrl}/escrows/${row.id}`, ev.receipt_sig],
    });
    log(`evidence committed for ${row.id.slice(0, 10)}… (${ev.submitted_by}) ${hash}`);
    store.update(row.id, { evidence_hash: ev.evidence_hash, evidence_tx: hash });
  } catch (e) {
    const r = reason(e);
    if (!/EvidenceAlreadySet|NotOpen/.test(r)) log(`commit evidence ${row.id.slice(0, 10)}…: ${r}`);
    await syncFromChain(row.id as Hex);
  }
}

async function proveEquivocation(row: EscrowRow, other: { evidence_hash: string; receipt_sig: string }) {
  try {
    const { hash } = await send({
      address: cfg.escrow, abi: escrowAbi as any, functionName: "proveEquivocation",
      args: [row.id, other.evidence_hash, other.receipt_sig],
    });
    log(`EQUIVOCATION proven for ${row.id.slice(0, 10)}…, buyer refunded ${hash}`);
    store.update(row.id, { final_tx: hash });
  } catch (e) {
    log(`prove equivocation ${row.id.slice(0, 10)}…: ${reason(e)}`);
  }
  await syncFromChain(row.id as Hex);
}

async function refund(row: EscrowRow) {
  try {
    const { hash } = await send({ address: cfg.escrow, abi: escrowAbi as any, functionName: "refundAfterDeadline", args: [row.id] });
    log(`deadline refund ${row.id.slice(0, 10)}… ${hash}`);
    store.update(row.id, { final_tx: hash });
  } catch (e) {
    log(`refund ${row.id.slice(0, 10)}…: ${reason(e)}`);
  }
  await syncFromChain(row.id as Hex);
}

async function record(row: EscrowRow) {
  if (!cfg.validator) return;
  try {
    const { hash, receipt } = await send({ address: cfg.validator, abi: validatorAbi as any, functionName: "record", args: [row.id] });
    const ev = parseEventLogs({ abi: validatorAbi, logs: receipt.logs, eventName: "Recorded" })[0];
    const score = ev ? Number(ev.args.score) : null;
    log(`ERC-8004 record for ${row.id.slice(0, 10)}… agent ${row.agent_id} score ${score} ${hash}`);
    store.update(row.id, { record_tx: hash, score, record_error: null });
    store.event(row.id, "erc8004_recorded", hash, `agent ${row.agent_id} scored ${score}`);
  } catch (e) {
    const r = reason(e);
    const permanent = /AlreadyRecorded|NotJudged|NoAgent|AgentNotPayee|RequestMismatch|Not authorized/.test(r);
    store.update(row.id, { record_error: permanent ? r : `retry:${r}` });
    log(`record ${row.id.slice(0, 10)}…: ${r}`);
  }
}

let fastBusy = false;
async function fastTick() {
  if (fastBusy) return;
  fastBusy = true;
  try {
    for (const row of store.active()) {
      const stored = store.evidenceFor(row.id);
      const onchain = row.evidence_hash;
      if (onchain) {
        const conflict = stored.find((x) => x.evidence_hash.toLowerCase() !== onchain.toLowerCase());
        if (conflict) { await proveEquivocation(row, conflict); continue; }
      }
      if (row.deadline && nowSec() > row.deadline) { await refund(row); continue; }
      if (!onchain && stored.length > 0 && row.state === 1) { await commitEvidence(row); continue; }
      if (onchain && row.state === 1) enqueueJudge(row.id);
    }
    for (const row of store.toRecord()) await record(row);
  } finally {
    fastBusy = false;
  }
}

// ---- judging (one at a time: model APIs rate-limit) ------------------------------------

const queue: string[] = [];
let judging = false;

function enqueueJudge(id: string) {
  const job = store.job(id);
  if (job && (job.status === "done" || job.status === "judging" || job.status === "failed")) return;
  if (!queue.includes(id)) { queue.push(id); store.setJob(id, "queued"); }
  void judgeLoop();
}

function attestationView(b: Bundle) {
  const roles = [...b.judges.map((_, i) => `judge ${String.fromCharCode(65 + i)}`), "grounding", "calibration"];
  return [...b.judges, b.grounding, b.calibration].map((a, i) => {
    const h = parseHeader(a.content);
    return { role: roles[i], model: a.model, signer: a.signer, requestId: a.requestId, verdict: h.verdict, conf: h.conf, header: a.content.slice(0, HEADER_LEN), rationale: h.rationale.trim(), signedText: a.signedText };
  });
}

async function judgeOne(id: string) {
  const row = store.get(id);
  if (!row || row.state !== 1 || !row.evidence_hash) return;
  const ev = store.evidenceFor(id).find((x) => x.evidence_hash.toLowerCase() === row.evidence_hash!.toLowerCase());
  if (!ev) { store.setJob(id, "waiting_evidence"); return; }
  if (!row.rubric) { await scan(); return; }
  const committedAt = store.events(id).find((x: any) => x.kind === "evidence_committed") as any;
  if (committedAt && Date.now() - committedAt.at < CHALLENGE_SECONDS * 1000) {
    await new Promise((r) => setTimeout(r, CHALLENGE_SECONDS * 1000 - (Date.now() - committedAt.at)));
  }
  if (row.deadline - nowSec() < 30) { store.setJob(id, "failed", "too close to deadline"); return; }

  store.setJob(id, "judging", undefined, true);
  store.event(id, "judging", null, "2 judges + grounding + calibration");
  log(`judging ${id.slice(0, 10)}…`);
  const c = { rubric: row.rubric, evidence: ev.body, rubricHash: row.rubric_hash as Hex, evidenceHash: row.evidence_hash as Hex };
  const bundle = await buildBundle(c, (m) => log(`  ${m.trim()}`));
  await registerSignersFor(bundle);

  // re-check right before paying: no conflicting receipt arrived meanwhile
  if (new Set(store.evidenceFor(id).map((x) => x.evidence_hash)).size > 1) { store.setJob(id, "queued"); return; }
  const e = await readEscrow(publicClient, cfg.escrow, id as Hex);
  const sa = settleArgs(bundle);
  const [outcome] = await publicClient.readContract({
    address: cfg.oracle, abi: oracleAbi, functionName: "resolve",
    args: [c.rubricHash, c.evidenceHash, e.policy, sa.judges, sa.grounding, sa.calibration],
  });
  store.saveVerdict(id, Number(outcome), attestationView(bundle));
  log(`  oracle.resolve -> ${["NO", "YES", "ESCALATE"][Number(outcome)]}`);
  const { hash, receipt } = await send({
    address: cfg.escrow, abi: escrowAbi as any, functionName: "settle",
    args: [id, sa.judges, sa.grounding, sa.calibration, sa.requestIds],
  });
  store.update(id, { settle_tx: hash, outcome: Number(outcome), settle_gas: receipt.gasUsed.toString() });
  store.setJob(id, "done");
  await syncFromChain(id as Hex);
  log(`  settled ${hash} (gas ${receipt.gasUsed})`);
  kick();
}

async function judgeLoop() {
  if (judging) return;
  judging = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      try {
        await judgeOne(id);
      } catch (e) {
        const job = store.job(id);
        const r = reason(e);
        log(`judge ${id.slice(0, 10)}… failed: ${r}`);
        store.setJob(id, (job?.attempts ?? 0) >= 3 ? "failed" : "retry", r);
        store.event(id, "judge_error", null, r.slice(0, 200));
      }
    }
  } finally {
    judging = false;
  }
}

// ---- loop ---------------------------------------------------------------------------

let kicked = false;
export function kick() {
  if (kicked) return;
  kicked = true;
  setTimeout(async () => { kicked = false; await scan(); await fastTick(); }, 300);
}

export function startKeeper() {
  const tick = async () => {
    await scan();
    await fastTick();
  };
  void tick();
  setInterval(tick, Number(process.env.KEEPER_INTERVAL_MS ?? 2500));
  log(`watching escrow ${cfg.escrow}${cfg.validator ? `, validator ${cfg.validator}` : ""}`);
}

export { toAttestedArg };

function deployBlock(): number | null {
  try {
    const f = process.env.DEPLOYMENT_FILE ?? `deployments/${cfg.chainId}.json`;
    const d = JSON.parse(readFileSync(f, "utf8"));
    return d.deployBlock ? Number(d.deployBlock) : null;
  } catch {
    return null;
  }
}
