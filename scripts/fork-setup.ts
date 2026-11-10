// Local anvil fork of Fuji: give every wallet AVAX and the agent real Fuji USDC (by writing the
// FiatToken balance slot), so the whole flow runs against the real USDC and ERC-8004 contracts.
//   anvil --fork-url https://api.avax-test.network/ext/bc/C/rpc --port 8545
//   bun --env-file=.env.fork run scripts/fork-setup.ts
import { createTestClient, encodeAbiParameters, http, keccak256, numberToHex, parseEther, publicActions, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { usdcAbi } from "@assay/x402";

const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const t = createTestClient({ mode: "anvil", transport: http(rpc) }).extend(publicActions);
const usdc = process.env.USDC as Hex;

for (const k of ["DEPLOYER", "SELLER_HONEST", "SELLER_LAZY", "SELLER_INJECTOR", "SELLER_SWAPPER"]) {
  const a = privateKeyToAccount(process.env[`${k}_PRIVATE_KEY`] as Hex).address;
  await t.setBalance({ address: a, value: parseEther("100") });
}

// find FiatToken's balance mapping slot by probing
const agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as Hex).address;
const amount = 50_000_000n; // 50 USDC
let slotFound: number | null = null;
for (let slot = 0; slot < 30 && slotFound === null; slot++) {
  const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [agent, BigInt(slot)]));
  const before = await t.getStorageAt({ address: usdc, slot: key });
  await t.setStorageAt({ address: usdc, index: key, value: numberToHex(amount, { size: 32 }) });
  const bal = await t.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [agent] });
  if (bal === amount) slotFound = slot;
  else await t.setStorageAt({ address: usdc, index: key, value: (before ?? numberToHex(0n, { size: 32 })) as Hex });
}
if (slotFound === null) throw new Error("could not find the USDC balance slot");
console.log(`fork funded: 100 AVAX to deployer + sellers, 50 USDC to agent ${agent} (FiatToken balance slot ${slotFound})`);
