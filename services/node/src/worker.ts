// Cloudflare host. One Worker serves the dapp (static assets) and forwards /api/* to a single
// SQLite-backed Durable Object that runs the same app as the Bun node: facilitator, demo sellers,
// evidence intake and the keeper. Alarms replace the Bun timers.
//   wrangler deploy   (config: wrangler.jsonc at the repo root)

import { DurableObject } from "cloudflare:workers";
import deployment from "../../../deployments/43113.json";
import { sellerRoutes } from "@countersign/sellers";
import { createApp, type Handler } from "./app";
import { loopbackFetch, setLocalHandler } from "./ctx";
import { durableObjectDriver } from "./db";
import { setDeployment } from "./deployment";
import { ensurePipelineSigners } from "./judgeKit";
import { pendingJudges, recoverJobs, runFast, runJudges, setKickHandler } from "./keeper";
import { initStore, store } from "./store";

const BUSY_MS = 3_000;   // keeper cadence while purchases are in flight
const IDLE_MS = 30_000;  // otherwise

export class CountersignNode extends DurableObject<Env> {
  private handle: Handler;
  private signersReady = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setDeployment(deployment as any);
    initStore(durableObjectDriver(ctx.storage.sql as any));
    recoverJobs();
    this.handle = createApp({ sellerRoutes: sellerRoutes({ fetchImpl: loopbackFetch, deployment: deployment as any }) });
    setLocalHandler(this.handle);
    setKickHandler(() => void this.schedule(250));
    ctx.blockConcurrencyWhile(() => this.schedule(1_000));
  }

  /** Bring the next alarm forward to at most `ms` from now. */
  private async schedule(ms: number) {
    const at = Date.now() + ms;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async fetch(req: Request): Promise<Response> {
    const res = await this.handle(req);
    if (req.method === "POST") await this.schedule(BUSY_MS);
    return res;
  }

  async alarm() {
    try {
      if (!this.signersReady) {
        await ensurePipelineSigners();
        this.signersReady = true;
      }
      await runFast();
      if (pendingJudges() > 0) await runJudges(1); // one verdict per alarm keeps each run short
      await runFast();
    } catch (e) {
      console.error("[keeper]", (e as Error).message);
    }
    const busy = pendingJudges() > 0 || store.active().length > 0;
    await this.schedule(busy ? BUSY_MS : IDLE_MS);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      // forwarded unchanged: the app strips its base path (NODE_URL) for routing only
      return env.NODE.get(env.NODE.idFromName("main")).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
