// Distribute from the deployer: a little AVAX to each seller (one-time ERC-8004 registration) and
// test USDC to the demo agent. The agent never needs AVAX.
//   bun run scripts/fund.ts [agentUsdc=5]
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { usdcAbi } from "@countersign/x402";

const rpc = process.env.RPC_URL!;
const client = createPublicClient({ transport: http(rpc) });
const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
const chainId = await client.getChainId();
const w = createWalletClient({ account: deployer, transport: http(rpc), chain: { id: chainId } as any });
const usdc = process.env.USDC as Hex;

const SELLER_AVAX = parseEther(process.env.SELLER_AVAX ?? "0.05");
for (const m of ["HONEST", "LAZY", "INJECTOR", "SWAPPER"]) {
  const a = privateKeyToAccount(process.env[`SELLER_${m}_PRIVATE_KEY`] as Hex).address;
  const bal = await client.getBalance({ address: a });
  if (bal >= SELLER_AVAX / 2n) { console.log(`seller ${m.toLowerCase().padEnd(9)} ${a} has ${formatEther(bal)} AVAX`); continue; }
  const h = await w.sendTransaction({ to: a, value: SELLER_AVAX - bal });
  await client.waitForTransactionReceipt({ hash: h });
  console.log(`seller ${m.toLowerCase().padEnd(9)} ${a} topped up to ${formatEther(SELLER_AVAX)} AVAX  ${h}`);
}

const agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as Hex).address;
const want = BigInt(Math.round(Number(process.argv[2] ?? "5") * 1e6));
const [agentBal, depBal] = await Promise.all([
  client.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [agent] }),
  client.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [deployer.address] }),
]);
if (agentBal >= want) {
  console.log(`agent ${agent} has ${Number(agentBal) / 1e6} USDC`);
} else if (depBal >= want - agentBal) {
  const h = await w.writeContract({ address: usdc, abi: usdcAbi, functionName: "transfer", args: [agent, want - agentBal] });
  await client.waitForTransactionReceipt({ hash: h });
  console.log(`agent ${agent} topped up to ${Number(want) / 1e6} USDC  ${h}`);
} else {
  console.log(`agent ${agent} has ${Number(agentBal) / 1e6} USDC and the deployer only ${Number(depBal) / 1e6}: get test USDC at https://faucet.circle.com (Avalanche Fuji) for either address`);
}
