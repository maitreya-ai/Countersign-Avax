// Create .env from .env.example and fill any missing private keys with fresh ones.
//   bun run scripts/gen-keys.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const KEYS = [
  "DEPLOYER_PRIVATE_KEY", "ATTESTER_PRIVATE_KEY", "AGENT_PRIVATE_KEY",
  "SELLER_HONEST_PRIVATE_KEY", "SELLER_LAZY_PRIVATE_KEY", "SELLER_INJECTOR_PRIVATE_KEY", "SELLER_SWAPPER_PRIVATE_KEY",
];

const file = process.argv[2] ?? ".env";
let env = existsSync(file) ? readFileSync(file, "utf8") : readFileSync(".env.example", "utf8");
for (const k of KEYS) {
  const re = new RegExp(`^${k}=(.*)$`, "m");
  const cur = env.match(re)?.[1]?.split("#")[0]?.trim();
  if (cur && cur.startsWith("0x")) continue;
  const pk = generatePrivateKey();
  env = re.test(env) ? env.replace(re, `${k}=${pk}`) : `${env}\n${k}=${pk}`;
}
writeFileSync(file, env);

const val = (k: string) => env.match(new RegExp(`^${k}=(0x[0-9a-fA-F]{64})`, "m"))![1] as `0x${string}`;
console.log(`keys in ${file}:`);
for (const k of KEYS) console.log(`  ${k.replace("_PRIVATE_KEY", "").padEnd(16)} ${privateKeyToAccount(val(k)).address}`);
console.log(`\nFund on Fuji:
  DEPLOYER  ~2 AVAX (deploys, pays keeper gas, tops up sellers) + test USDC for the agent (faucet.circle.com)
  everything else is distributed by: bun run scripts/fund.ts`);
