// Static configuration: everything the dapp needs to read the chain is bundled at build time,
// so pages never depend on a server being up.

import deployment from "./deployment.json";

type Addr = `0x${string}`;

export const CONFIG = {
  chainId: deployment.chainId as number,
  explorer: (deployment.explorer || "https://testnet.snowtrace.io") as string,
  deployBlock: BigInt((deployment as any).deployBlock ?? 0),
  /** JSON-RPC for calls. */
  rpc: process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc",
  /** JSON-RPC for event logs: allows wide eth_getLogs ranges (50k blocks) and browser CORS. If it fails,
   *  the reader re-scans the window in 100-block chunks on `rpc` (the public Fuji endpoint's cap). */
  logRpc: process.env.NEXT_PUBLIC_LOG_RPC_URL ?? "https://avalanche-fuji-c-chain-rpc.publicnode.com",
  logRange: BigInt(process.env.NEXT_PUBLIC_LOG_RANGE ?? 50_000),
  contracts: {
    usdc: deployment.contracts.usdc as Addr,
    escrow: deployment.contracts.escrow as Addr,
    oracle: deployment.contracts.oracle as Addr,
    signerRegistry: deployment.contracts.signerRegistry as Addr,
    validator: deployment.contracts.validator as Addr,
    identityRegistry: deployment.contracts.identityRegistry as Addr,
    validationRegistry: deployment.contracts.validationRegistry as Addr,
  },
  sellers: deployment.sellers as { name: string; address: Addr; agentId: string | null; resource: string }[],
  /** The Countersign node (x402 facilitator, demo sellers, keeper). Only needed to make purchases. */
  nodeUrl: (process.env.NEXT_PUBLIC_NODE_URL ?? "/api").replace(/\/$/, ""),
};

/** Absolute node URL (the x402 client needs absolute URLs). */
export function nodeUrlAbsolute(): string {
  if (/^https?:\/\//.test(CONFIG.nodeUrl)) return CONFIG.nodeUrl;
  return typeof window === "undefined" ? CONFIG.nodeUrl : new URL(CONFIG.nodeUrl, window.location.origin).toString().replace(/\/$/, "");
}

export const fuji = {
  id: CONFIG.chainId,
  name: "Avalanche Fuji",
  nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpc] } },
  blockExplorers: { default: { name: "Snowtrace", url: CONFIG.explorer } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" as Addr } },
  testnet: true,
} as const;
