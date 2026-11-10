// Smoke test of the live deployment (Cloudflare Worker + Durable Object + Fuji).
//   bun run test:live                      (BASE_URL defaults to the production URL)
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HEADERS, decodeHeader, type PaymentRequired } from "@countersign/x402";

const BASE = (process.env.BASE_URL ?? "https://countersign.maitreyak1806.workers.dev").replace(/\/$/, "");
const deployment = JSON.parse(readFileSync(fileURLToPath(new URL("../../deployments/43113.json", import.meta.url)), "utf8"));

describe(`live deployment ${BASE}`, () => {
  test("every page of the dapp is served", async () => {
    for (const p of ["/", "/live", "/sellers", "/try", "/protocol", "/escrow?id=0x00"]) {
      const r = await fetch(`${BASE}${p}`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("countersign");
    }
  }, 60_000);

  test("node API is up and wired to the deployed contracts", async () => {
    const health = await (await fetch(`${BASE}/api/health`)).json();
    expect(health.ok).toBe(true);
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    expect(cfg.chainId).toBe(43113);
    expect(cfg.contracts.escrow).toBe(deployment.contracts.escrow);
    expect(cfg.contracts.validator).toBe(deployment.contracts.validator);
    expect(cfg.nodeUrl).toBe(`${BASE}/api`);
  }, 60_000);

  test("each seller answers an unpaid call with a countersign offer", async () => {
    for (const s of deployment.sellers) {
      const r = await fetch(`${BASE}/api/${s.name}/summarize`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"document":"A short document."}' });
      expect(r.status).toBe(402);
      const offer = decodeHeader<PaymentRequired>(r.headers.get(HEADERS.required)!);
      const cs = offer.accepts.find((a) => a.scheme === "countersign")!;
      expect(cs.payTo).toBe(s.address);
      expect(cs.extra.agentId).toBe(s.agentId);
      expect(cs.extra.facilitator).toBe(`${BASE}/api`);
      expect(cs.resource).toBe(`${BASE}/api/${s.name}/summarize`);
    }
  }, 60_000);
});
