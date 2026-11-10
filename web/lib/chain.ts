"use client";

// Reads Countersign straight from Avalanche: escrow events (logs), live escrow state (multicall),
// ERC-8004 records, and the judges' verdicts and the judged evidence (decoded from the settle
// transaction's calldata). Nothing here depends on the Countersign node being up.

import { useSyncExternalStore } from "react";
import {
  createPublicClient, decodeFunctionData, fallback, hexToBytes, http, parseEventLogs, recoverMessageAddress,
  type Address, type Hex,
} from "viem";
import {
  NO_AGENT, REASON_NAMES, STATE_NAMES, VALIDATION_TAG_STRING, escrowAbi, validationRegistryAbi, validatorAbi,
} from "@countersign/x402";
import { CONFIG, fuji } from "./config";

/** What a reader needs to know about a deployment (the dapp passes the bundled Fuji config). */
export interface ReaderConfig {
  chainId: number;
  rpc: string;
  logRpc: string;
  logRange: bigint;
  deployBlock: bigint;
  contracts: { escrow: Address; validator: Address; validationRegistry: Address };
  sellers: { name: string; address: string; agentId: string | null }[];
}

export type StateName = (typeof STATE_NAMES)[number];
export type ReasonName = (typeof REASON_NAMES)[number];

export interface ChainEvent {
  escrowId: Hex;
  kind: "opened" | "evidence_committed" | "settled" | "equivocation_proven" | "arbitrated" | "deadline_refund" | "erc8004_recorded";
  tx: Hex;
  block: bigint;
  logIndex: number;
  detail?: string;
}

export interface ChainEscrow {
  id: Hex;
  payer: Address;
  payee: Address;
  amount: bigint;
  deadline: number;
  rubric: string;
  rubricHash: Hex;
  agentId: string | null;
  seller: string | null;
  evidenceHash: Hex | null;
  state: StateName;
  reason: ReasonName;
  outcome: "YES" | "NO" | "ESCALATE" | null;
  score: number | null;
  policy: { judges: number; minAgree: number; minConfBps: number; requireGrounded: boolean } | null;
  tx: { open: Hex | null; evidence: Hex | null; settle: Hex | null; final: Hex | null; record: Hex | null };
  openBlock: bigint;
  createdAt: number | null;
  events: ChainEvent[];
}

export interface SellerRecord { count: number; avg: number; selfFiling: boolean }

export interface ChainSnapshot {
  status: "loading" | "ready" | "error";
  error: string | null;
  escrows: ChainEscrow[];
  activity: ChainEvent[];
  records: Record<string, SellerRecord>;
  head: bigint | null;
  updatedAt: number;
}

const ZERO = `0x${"0".repeat(64)}`;
const OUTCOME = ["NO", "YES", "ESCALATE"] as const;

// ---- verdicts, decoded from the settle transaction ---------------------------------------------

export interface DecodedAttestation {
  role: string;
  model: string;
  verdict: "Y" | "N" | "U";
  conf: number;
  rationale: string;
  header: string;
  signer: Address;
  provider: Address;
  signedText: string;
  requestId: string;
}

export interface DecodedSettle {
  attestations: DecodedAttestation[];
  evidence: string | null;   // the exact evidence the judges were shown
  gasUsed: bigint | null;
}

const HEADER = /^VERDICT:([YNU]);CONF:(\d\.\d\d);RUBRIC:(0x[0-9a-fA-F]{64});EVID:(0x[0-9a-fA-F]{64});/;

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function evidenceFromRequest(reqBody: Uint8Array): string | null {
  try {
    const j = JSON.parse(new TextDecoder().decode(reqBody));
    const user: string = j.messages?.[1]?.content ?? "";
    const start = user.indexOf("EVIDENCE (untrusted):\n<<<\n");
    const end = user.indexOf("\n>>>\n", start);
    return start >= 0 && end > start ? user.slice(start + "EVIDENCE (untrusted):\n<<<\n".length, end) : null;
  } catch {
    return null;
  }
}

// ---- reader (one per deployment) ----------------------------------------------------------------

export function createChainReader(c: ReaderConfig) {
  const chain = { ...fuji, id: c.chainId, rpcUrls: { default: { http: [c.rpc] } } };
  const callClient = createPublicClient({ chain, transport: fallback([http(c.rpc), http(c.logRpc)]), batch: { multicall: true } });
  const logClient = createPublicClient({ chain, transport: http(c.logRpc, { retryCount: 2 }) });
  const SMALL = 100n; // the public Fuji endpoint's eth_getLogs cap

  /** Wide-range logs from the log provider; if it fails, the same window in 100-block chunks on `rpc`. */
  async function getLogsRobust(address: Address[], fromBlock: bigint, toBlock: bigint) {
    try {
      return await logClient.getLogs({ address, fromBlock, toBlock });
    } catch {
      const windows: [bigint, bigint][] = [];
      for (let f = fromBlock; f <= toBlock; f += SMALL) windows.push([f, f + SMALL - 1n < toBlock ? f + SMALL - 1n : toBlock]);
      const out: Awaited<ReturnType<typeof logClient.getLogs>> = [];
      for (let i = 0; i < windows.length; i += 5) {
        const batch = await Promise.all(windows.slice(i, i + 5).map(([f, t]) => callClient.getLogs({ address, fromBlock: f, toBlock: t })));
        for (const b of batch) out.push(...(b as any));
      }
      return out;
    }
  }
  const settleCache = new Map<string, Promise<DecodedSettle>>();

  const byId = new Map<string, ChainEscrow>();
  let records: Record<string, SellerRecord> = {};
  let lastScanned: bigint | null = null;
  let scans = 0;

  function sellerName(payee: string): string | null {
    return c.sellers.find((s) => s.address.toLowerCase() === payee.toLowerCase())?.name ?? null;
  }

  function entry(id: Hex): ChainEscrow {
    const key = id.toLowerCase();
    let e = byId.get(key);
    if (!e) {
      e = {
        id: key as Hex, payer: "0x0000000000000000000000000000000000000000", payee: "0x0000000000000000000000000000000000000000",
        amount: 0n, deadline: 0, rubric: "", rubricHash: ZERO as Hex, agentId: null, seller: null, evidenceHash: null,
        state: "Open", reason: "None", outcome: null, score: null, policy: null,
        tx: { open: null, evidence: null, settle: null, final: null, record: null }, openBlock: 0n, createdAt: null, events: [],
      };
      byId.set(key, e);
    }
    return e;
  }

  function push(e: ChainEscrow, ev: Omit<ChainEvent, "escrowId">) {
    if (!e.events.some((x) => x.tx === ev.tx && x.kind === ev.kind)) e.events.push({ ...ev, escrowId: e.id });
  }

  function applyLogs(raw: Awaited<ReturnType<typeof logClient.getLogs>>, touched: Set<string>): boolean {
    let recorded = false;
    const logs = parseEventLogs({ abi: [...escrowAbi, ...validatorAbi], logs: raw });
    for (const l of logs) {
      const a: any = l.args;
      const id: Hex = a.id ?? a.escrowId;
      if (!id) continue;
      const e = entry(id);
      touched.add(e.id);
      const base = { tx: l.transactionHash as Hex, block: l.blockNumber as bigint, logIndex: Number(l.logIndex) };
      switch (l.eventName) {
        case "Opened":
          Object.assign(e, { payer: a.payer, payee: a.payee, amount: a.amount, deadline: Number(a.deadline), rubric: a.rubric, rubricHash: a.rubricHash, seller: sellerName(a.payee), openBlock: l.blockNumber });
          e.tx.open = base.tx;
          push(e, { ...base, kind: "opened", detail: `${(Number(a.amount) / 1e6).toFixed(2)} USDC locked by a gasless signature` });
          break;
        case "OpenedWithAuthorization":
          e.agentId = a.agentId === NO_AGENT ? null : a.agentId.toString();
          break;
        case "EvidenceSet":
          e.evidenceHash = a.evidenceHash;
          e.tx.evidence = base.tx;
          push(e, { ...base, kind: "evidence_committed", detail: `evidence ${String(a.evidenceHash).slice(0, 10)}… with the seller's receipt` });
          break;
        case "Settled":
          e.outcome = OUTCOME[Number(a.outcome)] ?? null;
          e.tx.settle = base.tx;
          push(e, { ...base, kind: "settled", detail: `verdict ${e.outcome}` });
          break;
        case "Equivocated":
          e.tx.final = base.tx;
          push(e, { ...base, kind: "equivocation_proven", detail: "seller signed two different evidence hashes" });
          break;
        case "Arbitrated":
          e.tx.final = base.tx;
          push(e, { ...base, kind: "arbitrated", detail: a.released ? "released" : "refunded" });
          break;
        case "RefundedAfterDeadline":
          e.tx.final = base.tx;
          push(e, { ...base, kind: "deadline_refund" });
          break;
        case "Recorded":
          e.score = Number(a.score);
          e.tx.record = base.tx;
          recorded = true;
          push(e, { ...base, kind: "erc8004_recorded", detail: `agent #${a.agentId} scored ${a.score}` });
          break;
      }
    }
    return recorded;
  }

  async function refreshRecords() {
    const sellers = c.sellers.filter((s) => s.agentId);
    if (!sellers.length || !c.contracts.validator) return;
    const res = await callClient.multicall({
      allowFailure: true,
      contracts: sellers.flatMap((s) => [
        { address: c.contracts.validationRegistry, abi: validationRegistryAbi, functionName: "getSummary", args: [BigInt(s.agentId!), [c.contracts.validator], VALIDATION_TAG_STRING] } as const,
        { address: c.contracts.validator, abi: validatorAbi, functionName: "canSelfFile", args: [BigInt(s.agentId!)] } as const,
      ]),
    });
    const next: Record<string, SellerRecord> = {};
    sellers.forEach((s, i) => {
      const sum = res[2 * i]!, sf = res[2 * i + 1]!;
      const [count, avg] = sum.status === "success" ? (sum.result as readonly [bigint, number]) : [0n, 0];
      next[s.agentId!] = { count: Number(count), avg: Number(avg), selfFiling: sf.status === "success" ? Boolean(sf.result) : false };
    });
    records = next;
  }

  async function scanOnce(): Promise<ChainSnapshot> {
    const head = await callClient.getBlockNumber();
    let from = lastScanned === null ? c.deployBlock : lastScanned + 1n;
    const touched = new Set<string>();
    let recorded = false;
    while (from <= head) {
      const to = from + c.logRange - 1n < head ? from + c.logRange - 1n : head;
      const raw = await getLogsRobust([c.contracts.escrow, c.contracts.validator], from, to);
      recorded = applyLogs(raw, touched) || recorded;
      from = to + 1n;
    }
    lastScanned = head;

    // live state for anything new or not yet final
    const ids = [...byId.values()].filter((e) => touched.has(e.id) || e.state === "Open" || e.state === "Escalated").map((e) => e.id);
    if (ids.length) {
      const res = await callClient.multicall({ allowFailure: true, contracts: ids.map((id) => ({ address: c.contracts.escrow, abi: escrowAbi, functionName: "get", args: [id] }) as const) });
      res.forEach((r, i) => {
        if (r.status !== "success") return;
        const v: any = r.result;
        const e = byId.get(ids[i]!)!;
        e.state = STATE_NAMES[v.state] ?? "None";
        e.reason = REASON_NAMES[v.reason] ?? "None";
        e.evidenceHash = v.evidenceHash === ZERO ? null : v.evidenceHash;
        e.policy = { judges: Number(v.policy.judges), minAgree: Number(v.policy.minAgree), minConfBps: Number(v.policy.minConfBps), requireGrounded: Boolean(v.policy.requireGrounded) };
        if (e.agentId === null && v.agentId !== NO_AGENT) e.agentId = v.agentId.toString();
      });
    }

    // timestamps for new purchases (one block read per distinct block)
    const missing = [...byId.values()].filter((e) => e.createdAt === null && e.openBlock > 0n);
    const blocks = [...new Set(missing.map((e) => e.openBlock))].slice(0, 25);
    const times = await Promise.all(blocks.map((b) => callClient.getBlock({ blockNumber: b }).then((x) => [b, Number(x.timestamp) * 1000] as const).catch(() => [b, null] as const)));
    for (const [b, t] of times) for (const e of missing) if (e.openBlock === b && t) e.createdAt = t;

    if (recorded || scans % 8 === 0) await refreshRecords().catch(() => {});
    scans++;

    const escrows = [...byId.values()].filter((e) => e.openBlock > 0n).sort((a, b) => Number(b.openBlock - a.openBlock));
    const activity = escrows.flatMap((e) => e.events).sort((a, b) => Number(b.block - a.block) || b.logIndex - a.logIndex).slice(0, 40);
    return { status: "ready", error: null, escrows, activity, records, head, updatedAt: Date.now() } as ChainSnapshot;
  }

  function decodeSettle(hash: Hex): Promise<DecodedSettle> {
    let p = settleCache.get(hash);
    if (!p) {
      p = (async () => {
        const [txn, rcpt] = await Promise.all([callClient.getTransaction({ hash }), callClient.getTransactionReceipt({ hash }).catch(() => null)]);
        const { args } = decodeFunctionData({ abi: escrowAbi, data: txn.input });
        const [, judges, grounding, calibration, requestIds] = args as any;
        const all = [
          ...judges.map((j: any, i: number) => ({ role: `judge ${String.fromCharCode(65 + i)}`, ...j })),
          { role: "grounding", ...grounding },
          { role: "calibration", ...calibration },
        ];
        const attestations: DecodedAttestation[] = [];
        for (const [i, a] of all.entries()) {
          const req = hexToBytes(a.reqBody), resp = hexToBytes(a.respBody);
          const signedText = `${await sha256Hex(req)}:${await sha256Hex(resp)}`;
          const signer = await recoverMessageAddress({ message: signedText, signature: a.signature });
          const json = JSON.parse(new TextDecoder().decode(resp));
          const content: string = json.choices?.[0]?.message?.content ?? "";
          const m = HEADER.exec(content);
          attestations.push({
            role: a.role, model: json.model ?? "unknown", verdict: (m?.[1] ?? "U") as any, conf: Number(m?.[2] ?? 0),
            rationale: content.slice(166).trim(), header: content.slice(0, 166), signer, provider: a.provider, signedText,
            requestId: requestIds[i] ?? "",
          });
        }
        return { attestations, evidence: evidenceFromRequest(hexToBytes(judges[0].reqBody)), gasUsed: rcpt?.gasUsed ?? null };
      })();
      settleCache.set(hash, p);
      p.catch(() => settleCache.delete(hash));
    }
    return p;
  }

  return { scanOnce, decodeSettle, callClient };
}

// ---- the dapp's live store (Fuji, from the bundled deployment) -----------------------------------

const reader = createChainReader({
  chainId: CONFIG.chainId, rpc: CONFIG.rpc, logRpc: CONFIG.logRpc, logRange: CONFIG.logRange, deployBlock: CONFIG.deployBlock,
  contracts: CONFIG.contracts, sellers: CONFIG.sellers,
});
export const callClient = reader.callClient;
export const decodeSettle = reader.decodeSettle;

let snapshot: ChainSnapshot = { status: "loading", error: null, escrows: [], activity: [], records: {}, head: null, updatedAt: 0 };
const SERVER_SNAPSHOT = snapshot;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function loop() {
  if (running) return;
  running = true;
  try {
    snapshot = await reader.scanOnce();
  } catch (e) {
    snapshot = { ...snapshot, status: snapshot.escrows.length ? "ready" : "error", error: (e as Error).message.split("\n")[0] ?? "RPC error" };
  } finally {
    running = false;
  }
  listeners.forEach((l) => l());
  if (listeners.size) timer = setTimeout(loop, typeof document !== "undefined" && document.hidden ? 15_000 : 4_000);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1 && !running) { if (timer) clearTimeout(timer); void loop(); }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer) { clearTimeout(timer); timer = null; }
  };
}

/** Live view of every Countersign purchase, read from Avalanche. */
export function useChain(): ChainSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => SERVER_SNAPSHOT);
}

export function chainStats(escrows: ChainEscrow[]) {
  const refunded = escrows.filter((e) => ["VerdictNo", "ArbiterRefund", "DeadlineRefund", "Equivocation"].includes(e.reason));
  return {
    escrows: escrows.length,
    paid: escrows.filter((e) => e.reason === "VerdictYes").length,
    refunded: refunded.length,
    equivocations: escrows.filter((e) => e.reason === "Equivocation").length,
    open: escrows.filter((e) => e.state === "Open" || e.state === "Escalated").length,
    volume: escrows.reduce((s, e) => s + e.amount, 0n),
    refundedVolume: refunded.reduce((s, e) => s + e.amount, 0n),
    records: escrows.filter((e) => e.score !== null).length,
  };
}

