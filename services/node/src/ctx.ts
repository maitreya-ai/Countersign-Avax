// Shared node context: keeper wallet, deployed addresses, a serialised transaction sender so
// concurrent loops never race on the keeper's nonce, and an in-process "loopback" fetch so the
// node can call its own endpoints (sellers -> facilitator, demo agent -> sellers) without leaving
// the process. Everything is resolved lazily so a missing variable never crashes module startup.

import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hex } from "viem";
import { CHAIN_ID, NETWORK, addresses, publicClient, wallet } from "@countersign/core";

let keeperCache: ReturnType<typeof wallet> | null = null;
export function keeper() {
  keeperCache ??= wallet(process.env.KEEPER_PRIVATE_KEY ? "KEEPER_PRIVATE_KEY" : "DEPLOYER_PRIVATE_KEY");
  return keeperCache;
}

const env = (k: string) => process.env[k];

export const cfg = {
  get chainId() { return CHAIN_ID; },
  get network() { return NETWORK; },
  get usdc() { return addresses.usdc; },
  get escrow() { return addresses.escrow; },
  get oracle() { return addresses.oracle; },
  get registry() { return addresses.registry; },
  get validator() { return addresses.validator; },
  get identity() { return addresses.identity; },
  get validation() { return addresses.validation; },
  get port() { return Number(env("NODE_PORT") ?? env("PORT") ?? 8402); },
  get publicUrl() { return (env("NODE_URL") ?? `http://localhost:${env("NODE_PORT") ?? 8402}`).replace(/\/$/, ""); },
  get sellersUrl() { return (env("SELLERS_URL") ?? "http://localhost:8403").replace(/\/$/, ""); },
  get judgePrice() { return BigInt(Math.round(Number(env("JUDGE_PRICE_USDC") ?? "0.05") * 1e6)); },
  get exactFacilitator() { return env("FACILITATOR_EXACT") ?? "local"; },
  get payaiUrl() { return env("PAYAI_FACILITATOR_URL") ?? "https://facilitator.payai.network"; },
  get demoEnabled() { return env("DEMO_ENABLED") === "1"; },
};

// ---- loopback fetch ------------------------------------------------------------------------

let localHandler: ((req: Request) => Promise<Response>) | null = null;

/** Register the node's own request handler for in-process calls to cfg.publicUrl. */
export function setLocalHandler(h: (req: Request) => Promise<Response>) {
  localHandler = h;
}

/** fetch() that serves requests to this node's own public URL in-process (same URL, no network). */
export const loopbackFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (localHandler && url.startsWith(cfg.publicUrl)) {
    return localHandler(input instanceof Request && !init ? input : new Request(url, init));
  }
  return fetch(input as any, init);
}) as typeof fetch;

/** Path prefix the node is published under (e.g. "/api" on Cloudflare, "" locally). */
export function basePath(): string {
  try {
    return new URL(cfg.publicUrl).pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

// ---- transactions -----------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

/** Send one contract write at a time and wait for its receipt. */
export function send(args: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; gas?: bigint }) {
  const run = async () => {
    const k = keeper();
    const hash = await k.client.writeContract({ ...(args as any), account: k.account, chain: undefined });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return { hash: hash as Hex, receipt };
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/** Short, readable revert reason. */
export function reason(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data?.errorName) return r.data.errorName + (r.data.args?.length ? `(${r.data.args.join(", ")})` : "");
    if (r?.reason) return r.reason;
    return e.shortMessage;
  }
  return (e as Error)?.message ?? String(e);
}
