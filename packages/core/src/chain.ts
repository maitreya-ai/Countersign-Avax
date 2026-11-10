// Avalanche network config, clients and deployed addresses. Env-driven so the same code runs on
// Fuji (default), a local anvil fork of Fuji, or C-Chain mainnet.

import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 43113);
export const RPC_URL = process.env.RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc";
export const EXPLORER = process.env.EXPLORER ?? (CHAIN_ID === 43114 ? "https://snowtrace.io" : "https://testnet.snowtrace.io");
export const NETWORK = `eip155:${CHAIN_ID}`;

export const avalanche = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 43114 ? "Avalanche C-Chain" : CHAIN_ID === 43113 ? "Avalanche Fuji" : `Avalanche (local ${CHAIN_ID})`,
  nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Snowtrace", url: EXPLORER } },
  testnet: CHAIN_ID !== 43114,
});

export const publicClient = createPublicClient({ chain: avalanche, transport: http(RPC_URL), pollingInterval: 1000 });

export function account(envName: string) {
  const pk = process.env[envName];
  if (!pk) throw new Error(`${envName} is not set (see .env.example)`);
  return privateKeyToAccount(pk as Hex);
}

export function wallet(envName = "DEPLOYER_PRIVATE_KEY") {
  const acct = account(envName);
  return { account: acct, client: createWalletClient({ account: acct, chain: avalanche, transport: http(RPC_URL) }) };
}

export function addr(env: string): Address {
  const v = process.env[env];
  if (!v) throw new Error(`${env} is not set (deploy with scripts/deploy.sh first)`);
  return v as Address;
}

export function optAddr(env: string): Address | undefined {
  const v = process.env[env];
  return v ? (v as Address) : undefined;
}

export const addresses = {
  get usdc() { return addr("USDC"); },
  get escrow() { return addr("ASSAY_ESCROW"); },
  get oracle() { return addr("ASSAY_ORACLE"); },
  get registry() { return addr("SIGNER_REGISTRY"); },
  get validator() { return optAddr("ASSAY_VALIDATOR"); },
  get identity() { return optAddr("ERC8004_IDENTITY"); },
  get validation() { return optAddr("ERC8004_VALIDATION"); },
};

export function txUrl(hash: Hex) { return `${EXPLORER}/tx/${hash}`; }
export function addressUrl(a: Address) { return `${EXPLORER}/address/${a}`; }

export const usdcUnits = (n: number | string) => BigInt(Math.round(Number(n) * 1e6));
export const fmtUsdc = (v: bigint) => (Number(v) / 1e6).toFixed(2);
