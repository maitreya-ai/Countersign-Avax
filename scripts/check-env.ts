// Print every wallet's balances and flag missing configuration.
//   bun run scripts/check-env.ts
import { createPublicClient, formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { usdcAbi } from "@countersign/x402";

const rpc = process.env.RPC_URL!;
const client = createPublicClient({ transport: http(rpc) });
const usdc = process.env.USDC as Hex;
console.log(`chain ${await client.getChainId()}  rpc ${rpc}`);
for (const k of ["DEPLOYER", "AGENT", "SELLER_HONEST", "SELLER_LAZY", "SELLER_INJECTOR", "SELLER_SWAPPER", "ATTESTER"]) {
  const pk = process.env[`${k}_PRIVATE_KEY`];
  if (!pk) { console.log(`  ${k.padEnd(16)} MISSING (run scripts/gen-keys.ts)`); continue; }
  const a = privateKeyToAccount(pk as Hex).address;
  const [avax, u] = await Promise.all([
    client.getBalance({ address: a }),
    client.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [a] }).catch(() => 0n),
  ]);
  console.log(`  ${k.padEnd(16)} ${a}  ${Number(formatEther(avax)).toFixed(4)} AVAX  ${(Number(u) / 1e6).toFixed(2)} USDC`);
}
const need = ["COUNTERSIGN_ESCROW", "COUNTERSIGN_ORACLE", "SIGNER_REGISTRY", "COUNTERSIGN_VALIDATOR"];
for (const k of need) if (!process.env[k]) console.log(`  ${k} not set (run scripts/deploy.ts)`);
const judges = [process.env.JUDGE_A, process.env.JUDGE_B, process.env.GROUNDING, process.env.CALIBRATION];
if (judges.some((m) => m?.startsWith("groq:")) && !process.env.GROQ_API_KEY) console.log("  GROQ_API_KEY not set (judges use groq:)");
if (judges.some((m) => m?.startsWith("gemini:")) && !process.env.GEMINI_API_KEY) console.log("  GEMINI_API_KEY not set (judges use gemini:)");
