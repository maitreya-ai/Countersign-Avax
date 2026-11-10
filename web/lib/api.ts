"use client";

import { useEffect, useRef, useState } from "react";

export const NODE_URL = (process.env.NEXT_PUBLIC_NODE_URL ?? "http://localhost:8402").replace(/\/$/, "");

export interface NodeConfig {
  chainId: number;
  rpc: string;
  explorer: string;
  network: string;
  contracts: {
    usdc: `0x${string}`;
    escrow: `0x${string}`;
    oracle: `0x${string}`;
    signerRegistry: `0x${string}`;
    validator: `0x${string}` | null;
    identityRegistry: `0x${string}` | null;
    validationRegistry: `0x${string}` | null;
  };
  judges: { count: number; models: Record<string, string> };
  sellers: { name: string; address: `0x${string}`; agentId: string | null; resource: string }[];
  sellersUrl: string;
  nodeUrl: string;
  demoEnabled: boolean;
  judgePrice: string;
}

export interface EscrowSummary {
  id: `0x${string}`;
  payer: `0x${string}`;
  payee: `0x${string}`;
  amount: string;
  deadline: number;
  rubric: string;
  agentId: string | null;
  seller: string | null;
  resource: string | null;
  state: "None" | "Open" | "Resolved" | "Refunded" | "Escalated";
  reason: "None" | "VerdictYes" | "VerdictNo" | "ArbiterRelease" | "ArbiterRefund" | "DeadlineRefund" | "Equivocation";
  outcome: "NO" | "YES" | "ESCALATE" | null;
  evidenceHash: `0x${string}` | null;
  score: number | null;
  recordError: string | null;
  tx: { open: string | null; evidence: string | null; settle: string | null; final: string | null; record: string | null };
  settleGas: string | null;
  job: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Attestation {
  role: string;
  model: string;
  signer: `0x${string}`;
  requestId: string;
  verdict: "Y" | "N" | "U";
  conf: number;
  header: string;
  rationale: string;
  signedText: string;
}

export interface EscrowDetail extends EscrowSummary {
  evidence: { hash: string; body: string; receipt: string; by: string; at: number }[];
  verdict: { outcome: number; attestations: Attestation[] } | null;
  events: { kind: string; tx: string | null; detail: string | null; at: number }[];
}

export interface SellerRow {
  name: string;
  address: `0x${string}`;
  agentId: string | null;
  resource: string;
  record: { count: number; avg: number; selfFiling: boolean };
  sales: { sales: number; paid: number | null; refunded: number | null };
}

export interface Stats {
  escrows: number;
  paid: number | null;
  refunded: number | null;
  equivocations: number | null;
  open: number | null;
  volume: number | null;
  refunded_volume: number | null;
  records: number | null;
  keeper: string;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${NODE_URL}${path}`, { cache: "no-store", ...init });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as any).error ?? `HTTP ${res.status}`);
  return j as T;
}

/** Fetch `path` now and every `ms` milliseconds while mounted. */
export function usePoll<T>(path: string | null, ms = 2500) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!path) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const d = await api<T>(path);
        if (alive.current) { setData(d); setError(null); }
      } catch (e) {
        if (alive.current) setError((e as Error).message);
      }
      if (alive.current && ms > 0) timer = setTimeout(tick, ms);
    };
    void tick();
    return () => { alive.current = false; clearTimeout(timer); };
  }, [path, ms]);
  return { data, error };
}

let configPromise: Promise<NodeConfig> | null = null;
export function getConfig(): Promise<NodeConfig> {
  configPromise ??= api<NodeConfig>("/config").catch((e) => { configPromise = null; throw e; });
  return configPromise;
}

export function useConfig() {
  const [cfg, setCfg] = useState<NodeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getConfig().then(setCfg, (e) => setError((e as Error).message)); }, []);
  return { cfg, error };
}
