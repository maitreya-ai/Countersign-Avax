// Give each demo seller an ERC-8004 identity and let CountersignValidator file its validation records
// (so a seller cannot hide failed sales). Writes the agent ids to deployments/<chainId>.json.
//   bun run scripts/register-sellers.ts
import { createPublicClient, createWalletClient, http, parseEventLogs, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { identityRegistryAbi } from "@countersign/x402";
import { readDeployment, writeDeployment } from "./lib";

const rpc = process.env.RPC_URL!;
const client = createPublicClient({ transport: http(rpc) });
const chainId = await client.getChainId();
const identity = process.env.ERC8004_IDENTITY as Address;
const validator = process.env.COUNTERSIGN_VALIDATOR as Address;
const sellersUrl = (process.env.SELLERS_URL ?? "http://localhost:8403").replace(/\/$/, "");
if (!identity || !validator) throw new Error("ERC8004_IDENTITY and COUNTERSIGN_VALIDATOR must be set (run scripts/deploy.ts)");

const d = readDeployment(chainId);
for (const name of ["honest", "lazy", "injector", "swapper"]) {
  const acct = privateKeyToAccount(process.env[`SELLER_${name.toUpperCase()}_PRIVATE_KEY`] as Hex);
  const w = createWalletClient({ account: acct, transport: http(rpc), chain: { id: chainId } as any });
  const resource = `${sellersUrl}/${name}/summarize`;
  let entry = d.sellers.find((s) => s.name === name && s.address.toLowerCase() === acct.address.toLowerCase());
  let agentId = entry?.agentId ? BigInt(entry.agentId) : null;
  if (agentId !== null) {
    const owner = await client.readContract({ address: identity, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }).catch(() => null);
    if (owner?.toLowerCase() !== acct.address.toLowerCase()) agentId = null;
  }
  if (agentId === null) {
    const card = { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: `countersign-demo-${name}`, description: `Countersign demo seller (${name}): 5-bullet summaries, judged before payment`, services: [{ name: "x402-countersign", endpoint: resource }] };
    const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString("base64")}`;
    const h = await w.writeContract({ address: identity, abi: identityRegistryAbi, functionName: "register", args: [uri] });
    const r = await client.waitForTransactionReceipt({ hash: h });
    agentId = parseEventLogs({ abi: identityRegistryAbi, logs: r.logs, eventName: "Registered" })[0]!.args.agentId;
    console.log(`${name.padEnd(9)} registered agent ${agentId}  ${h}`);
  }
  const approved = await client.readContract({ address: identity, abi: identityRegistryAbi, functionName: "getApproved", args: [agentId] });
  if (approved.toLowerCase() !== validator.toLowerCase()) {
    const h = await w.writeContract({ address: identity, abi: identityRegistryAbi, functionName: "approve", args: [validator, agentId] });
    await client.waitForTransactionReceipt({ hash: h });
    console.log(`${name.padEnd(9)} approved CountersignValidator for agent ${agentId}  ${h}`);
  }
  d.sellers = d.sellers.filter((s) => s.name !== name);
  d.sellers.push({ name, address: acct.address, agentId: agentId.toString(), resource });
}
writeDeployment(d);
console.log(`\nsellers written to ${process.env.DEPLOYMENT_FILE ?? `deployments/${chainId}.json`}`);
