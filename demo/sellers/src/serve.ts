// Standalone demo sellers server (local runs). The node can also mount the same routes (MOUNT_SELLERS=1).
//   bun run demo/sellers/src/serve.ts
import { existsSync, readFileSync } from "node:fs";
import { CORS_HEADERS } from "@countersign/x402";
import { CHAIN_ID } from "@countersign/core";
import { sellerRoutes, sellersHealth } from "./index";

const f = process.env.DEPLOYMENT_FILE ?? `deployments/${CHAIN_ID}.json`;
const routes = sellerRoutes({ deployment: existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { sellers: [] } });
const server = Bun.serve({
  port: Number(process.env.SELLERS_PORT ?? 8403),
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname === "/" || url.pathname === "/health") return Response.json(sellersHealth(), { headers: CORS_HEADERS });
    const route = routes.get(url.pathname);
    if (!route) return Response.json({ error: "not found" }, { status: 404, headers: CORS_HEADERS });
    return route(req);
  },
});
console.log(`demo sellers on :${server.port}  facilitator ${process.env.NODE_URL ?? "http://localhost:8402"}`);
