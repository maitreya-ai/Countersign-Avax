// countersign node, local host (Bun): x402 facilitator + evidence intake + keeper + read API.
//   bun run services/node/src/index.ts            (MOUNT_SELLERS=1 also serves the demo sellers)
// The same app runs on Cloudflare as a Durable Object: see worker.ts.

import { existsSync, readFileSync } from "node:fs";
import { CHAIN_ID } from "@countersign/core";
import { createApp } from "./app";
import { cfg, keeper, loopbackFetch, setLocalHandler } from "./ctx";
import { bunDriver } from "./db-bun";
import { getDeployment, setDeployment } from "./deployment";
import { ensurePipelineSigners } from "./judgeKit";
import { startKeeper } from "./keeper";
import { initStore } from "./store";

const deploymentPath = process.env.DEPLOYMENT_FILE ?? `deployments/${CHAIN_ID}.json`;
setDeployment(existsSync(deploymentPath) ? JSON.parse(readFileSync(deploymentPath, "utf8")) : { sellers: [] });
initStore(bunDriver());

const sellerRoutes = process.env.MOUNT_SELLERS === "1"
  ? (await import("@countersign/sellers")).sellerRoutes({ fetchImpl: loopbackFetch, deployment: getDeployment() as any })
  : null;
const handle = createApp({ sellerRoutes });
setLocalHandler(handle);

const server = Bun.serve({ port: cfg.port, idleTimeout: 120, fetch: handle });
console.log(`countersign node on :${server.port}  chain ${CHAIN_ID}  escrow ${cfg.escrow}  keeper ${keeper().account.address}`);
ensurePipelineSigners().catch((e) => console.warn(`[judges] could not register signers yet: ${(e as Error).message}`));
startKeeper();
