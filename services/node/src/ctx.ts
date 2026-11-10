// Shared node context: keeper wallet, deployed addresses, and a serialised transaction sender so
// concurrent loops never race on the keeper's nonce.

import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hex } from "viem";
import { CHAIN_ID, NETWORK, addresses, publicClient, wallet } from "@assay/core";

export const keeper = wallet(process.env.KEEPER_PRIVATE_KEY ? "KEEPER_PRIVATE_KEY" : "DEPLOYER_PRIVATE_KEY");

export const cfg = {
  chainId: CHAIN_ID,
  network: NETWORK,
  usdc: addresses.usdc,
  escrow: addresses.escrow,
  oracle: addresses.oracle,
  registry: addresses.registry,
  validator: addresses.validator,
  identity: addresses.identity,
  validation: addresses.validation,
  port: Number(process.env.NODE_PORT ?? process.env.PORT ?? 8402),
  publicUrl: (process.env.NODE_URL ?? `http://localhost:${process.env.NODE_PORT ?? 8402}`).replace(/\/$/, ""),
  sellersUrl: (process.env.SELLERS_URL ?? "http://localhost:8403").replace(/\/$/, ""),
  judgePrice: BigInt(Math.round(Number(process.env.JUDGE_PRICE_USDC ?? "0.05") * 1e6)),
  exactFacilitator: process.env.FACILITATOR_EXACT ?? "local", // local | payai
  payaiUrl: process.env.PAYAI_FACILITATOR_URL ?? "https://facilitator.payai.network",
  demoEnabled: process.env.DEMO_ENABLED === "1",
};

let chain: Promise<unknown> = Promise.resolve();

/** Send one contract write at a time and wait for its receipt. */
export function send(args: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; gas?: bigint }) {
  const run = async () => {
    const hash = await keeper.client.writeContract({ ...(args as any), account: keeper.account, chain: undefined });
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
