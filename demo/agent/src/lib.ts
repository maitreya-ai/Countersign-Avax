// Demo buyer agent: buys a 5-bullet summary over x402 `countersign` from one of the demo sellers.

import { readFileSync } from "node:fs";
import type { LocalAccount, PublicClient } from "viem";
import { fetchWithCountersign, getOffer, sellerTrust, type Purchase, type SellerTrust } from "@countersign/x402";

export const ARTICLE = readFileSync(new URL("../fixtures/article.txt", import.meta.url), "utf8");
export const SELLER_NAMES = ["honest", "lazy", "injector", "swapper"] as const;
export type SellerName = (typeof SELLER_NAMES)[number];

/** The exact request body bytes (they become part of the evidence). */
export function summarizeBody(document: string = ARTICLE): string {
  return JSON.stringify({ document, bullets: 5 });
}

export function sellerUrl(base: string, name: string) {
  return `${base.replace(/\/$/, "")}/${name}/summarize`;
}

export async function inspectSeller(base: string, name: string, client: PublicClient): Promise<{ trust: SellerTrust | null; price: string; rubric: string }> {
  const offer = await getOffer(sellerUrl(base, name), { method: "POST", headers: { "Content-Type": "application/json" }, body: summarizeBody() });
  if (!offer.countersign) throw new Error(`${name} does not offer the countersign scheme`);
  return { trust: await sellerTrust(client, offer.countersign).catch(() => null), price: offer.countersign.amount, rubric: offer.countersign.extra.rubric };
}

export async function buyFrom(
  base: string,
  name: string,
  opts: { account: LocalAccount; publicClient: PublicClient; maxAmount?: bigint; log?: (m: string) => void; document?: string },
): Promise<Purchase> {
  return fetchWithCountersign(
    sellerUrl(base, name),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: summarizeBody(opts.document) },
    {
      account: opts.account, publicClient: opts.publicClient, prefer: "countersign", maxAmount: opts.maxAmount ?? 1_000_000n,
      minTrust: { minCount: 1_000_000, minAvg: 0 }, // read the record, never refuse (the demo compares sellers itself)
      log: opts.log,
    },
  );
}
