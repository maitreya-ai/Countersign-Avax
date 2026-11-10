// Small helpers shared by the ops scripts: .env editing and the deployments/<chainId>.json record.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export function setEnv(updates: Record<string, string>, file = process.env.ENV_FILE ?? ".env") {
  let env = existsSync(file) ? readFileSync(file, "utf8") : "";
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    env = re.test(env) ? env.replace(re, `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
    process.env[k] = v;
  }
  writeFileSync(file, env);
}

export interface Deployment {
  chainId: number;
  network: string;
  rpc: string;
  explorer: string;
  deployedAt?: string;
  contracts: Record<string, string | null>;
  sellers: { name: string; address: string; agentId: string | null; resource: string }[];
}

export function deploymentPath(chainId: number) {
  return process.env.DEPLOYMENT_FILE ?? `deployments/${chainId}.json`;
}

export function readDeployment(chainId: number): Deployment {
  const p = deploymentPath(chainId);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  return {
    chainId, network: chainId === 43113 ? "fuji" : chainId === 43114 ? "avalanche" : `local-${chainId}`,
    rpc: process.env.RPC_URL ?? "", explorer: process.env.EXPLORER ?? "", contracts: {}, sellers: [],
  };
}

export function writeDeployment(d: Deployment) {
  mkdirSync("deployments", { recursive: true });
  writeFileSync(deploymentPath(d.chainId), JSON.stringify(d, null, 2) + "\n");
}
