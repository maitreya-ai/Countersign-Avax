// Deploy SignerRegistry, CountersignOracle, CountersignEscrow, CountersignValidator and record the addresses.
//   bun run scripts/deploy.ts            # uses RPC_URL / CHAIN_ID from .env (Fuji by default)
//   VERIFY=1 bun run scripts/deploy.ts   # also verify on Snowtrace (Routescan)
import { $ } from "bun";
import { formatEther, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readDeployment, setEnv, writeDeployment } from "./lib";

const rpc = process.env.RPC_URL!;
const chainId = Number(process.env.CHAIN_ID ?? 43113);
const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`);
const client = createPublicClient({ transport: http(rpc) });
const bal = await client.getBalance({ address: deployer.address });
console.log(`deployer ${deployer.address}  ${formatEther(bal)} AVAX on chain ${chainId}`);
if (bal === 0n) throw new Error("deployer has no AVAX: fund it first (Fuji faucet: https://core.app/tools/testnet-faucet)");

const deployBlock = await client.getBlockNumber();
const verify = process.env.VERIFY === "1" && chainId !== 31337
  ? ["--verify", "--verifier-url", `https://api.routescan.io/v2/network/${chainId === 43114 ? "mainnet" : "testnet"}/evm/${chainId}/etherscan`, "--etherscan-api-key", "verifyContract"]
  : [];
const out = await $`forge script script/Deploy.s.sol --rpc-url ${rpc} --broadcast --slow ${verify}`.cwd("contracts").env({ ...process.env } as any).text();
console.log(out.split("\n").filter((l) => /=0x|Contract Address|verified|Success/i.test(l)).join("\n"));

const found: Record<string, string> = {};
for (const m of out.matchAll(/^\s*([A-Z_]+)=(0x[0-9a-fA-F]{40})\s*$/gm)) found[m[1]!] = m[2]!;
for (const k of ["SIGNER_REGISTRY", "COUNTERSIGN_ORACLE", "COUNTERSIGN_ESCROW"]) if (!found[k]) throw new Error(`deploy output missing ${k}`);
if (found.COUNTERSIGN_VALIDATOR === "0x0000000000000000000000000000000000000000") found.COUNTERSIGN_VALIDATOR = "";
setEnv(found);

const d = readDeployment(chainId);
d.rpc = rpc;
d.explorer = process.env.EXPLORER ?? "";
d.deployedAt = new Date().toISOString();
(d as any).deployBlock = Number(deployBlock);
d.contracts = {
  usdc: process.env.USDC!, signerRegistry: found.SIGNER_REGISTRY!, oracle: found.COUNTERSIGN_ORACLE!, escrow: found.COUNTERSIGN_ESCROW!,
  validator: found.COUNTERSIGN_VALIDATOR || null, identityRegistry: process.env.ERC8004_IDENTITY || null, validationRegistry: process.env.ERC8004_VALIDATION || null,
};
d.sellers = []; // agent ids are per deployment of the validator; re-run register-sellers
writeDeployment(d);
console.log(`\nwritten to ${process.env.ENV_FILE ?? ".env"} and ${process.env.DEPLOYMENT_FILE ?? `deployments/${chainId}.json`}`);
