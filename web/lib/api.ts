"use client";

// The Countersign node is only needed to MAKE purchases (x402 facilitator, demo sellers, keeper).
// Everything the dapp displays is read from Avalanche directly (lib/chain.ts).

import { useEffect, useRef, useState } from "react";
import { CONFIG } from "./config";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CONFIG.nodeUrl}${path}`, { cache: "no-store", ...init });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as any).error ?? `node returned HTTP ${res.status}`);
  return j as T;
}

/** Off-chain extras the node holds for one purchase: evidence bytes + receipts, judging status. */
export interface NodeEscrowExtras {
  evidence: { hash: string; body: string; receipt: string; by: string; at: number }[];
  job: string | null;
}

/** Poll a node path while mounted; never throws (the node is optional for reading). */
export function useNode<T>(path: string | null, ms = 4000) {
  const [data, setData] = useState<T | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!path) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const d = await api<T>(path);
        if (alive.current) { setData(d); setOnline(true); }
      } catch {
        if (alive.current) setOnline(false);
      }
      if (alive.current && ms > 0) timer = setTimeout(tick, ms);
    };
    void tick();
    return () => { alive.current = false; clearTimeout(timer); };
  }, [path, ms]);
  return { data, online };
}
